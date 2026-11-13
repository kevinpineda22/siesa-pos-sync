// Reproceso manual desde tablas acumuladas del POS (dispara GitHub Actions).
//
// La lectura de las tablas acumuladas es pesada y no cabe en el límite de tiempo de Vercel,
// por eso se delega al workflow sync-pos.yml mediante workflow_dispatch.
const axios = require('axios');
const logger = require('./logger');
const { TIPOS_DOCUMENTO, normalizarTipos, validarFechaDocto, exigirDocumentos } = require('./opcionesReproceso');

const REGEX_DOCUMENTO = /^\d{1,3}-[A-Za-z0-9]+-\d+$/;
const MAX_DOCUMENTOS = 300;
const ESTADOS_RUN_ACTIVO = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

const FLUJOS = ['normal', 'genericos'];
const COS_GENERICOS = ['011', '012'];

// Normaliza el flujo pedido: 'normal' (default) o 'genericos'. Lanza si es otro valor.
function normalizarFlujo(raw) {
    const flujo = String(raw ?? '').trim().toLowerCase() || 'normal';
    if (!FLUJOS.includes(flujo)) {
        throw new Error(`flujo inválido: "${flujo}". Valores permitidos: ${FLUJOS.join(' | ')}.`);
    }
    return flujo;
}

function configGithub(flujo = 'normal') {
    const repo = process.env.GITHUB_REPO || 'kevinpineda22/siesa-pos-sync';
    const workflow = flujo === 'genericos'
        ? (process.env.GITHUB_WORKFLOW_GENERICOS || 'sync-011-gen.yml')
        : (process.env.GITHUB_WORKFLOW_SYNC_POS || 'sync-pos.yml');
    return {
        token: process.env.GITHUB_TOKEN,
        ref: process.env.GITHUB_REF || 'main',
        apiBase: `https://api.github.com/repos/${repo}/actions/workflows/${workflow}`,
        actionsUrl: `https://github.com/${repo}/actions/workflows/${workflow}`
    };
}

function headersGithub(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

// Mensaje de error sin exponer el token.
function mensajeError(error) {
    const msg = String(error.response?.data?.message || error.message || 'Error desconocido');
    const token = process.env.GITHUB_TOKEN;
    return token ? msg.split(token).join('***') : msg;
}

function responderError(res, error) {
    if (error.response) {
        return res.status(502).json({ success: false, error: `Error de GitHub: ${mensajeError(error)}` });
    }
    return res.status(500).json({ success: false, error: mensajeError(error) });
}

const ERROR_SIN_TOKEN = 'GITHUB_TOKEN no está configurado. Debe definirse en las variables de entorno de Vercel.';

// Middleware: exige un access token de Supabase válido (Authorization: Bearer <token>).
async function requireSupabaseUser(req, res, next) {
    try {
        const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return res.status(401).json({ success: false, error: 'Falta el token de autenticación.' });
        }
        const { data, error } = await logger.supabase.auth.getUser(match[1].trim());
        if (error || !data?.user) {
            return res.status(401).json({ success: false, error: 'Sesión no válida o expirada.' });
        }
        req.user = data.user;
        next();
    } catch (error) {
        res.status(401).json({ success: false, error: 'No se pudo validar la sesión.' });
    }
}

// Normaliza CO-CAJA-CONSEC: CO a 3 dígitos, caja en mayúsculas, consecutivo sin ceros a la izquierda.
function normalizarDocumento(doc) {
    const [co, caja, consec] = doc.split('-');
    return `${co.padStart(3, '0')}-${caja.toUpperCase()}-${String(parseInt(consec, 10))}`;
}

/**
 * POST /api/reprocesar-acumulado
 * Body: { documentos: ["001-Z02-36298", ...], tipos?: 'ambas'|'CNZ'|'CFZ', fechaDocto?: 'YYYY-MM-DD',
 *         flujo?: 'normal'|'genericos', fuente?: 'vivo'|'acumulado' }
 * - flujo 'normal' (default): lanza sync-pos.yml con fuente=acumulado (`fuente` del body se ignora).
 * - flujo 'genericos': solo CO 011/012; lanza sync-011-gen.yml con entorno=PROD (obligatorio, el
 *   default del workflow es QA). `fuente` default 'acumulado'; 'vivo' para las genéricas de HOY.
 * Responde 202.
 */
async function reprocesarAcumulado(req, res) {
    try {
        let flujo;
        try {
            flujo = normalizarFlujo(req.body?.flujo);
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
        }
        const cfg = configGithub(flujo);
        if (!cfg.token) return res.status(500).json({ success: false, error: ERROR_SIN_TOKEN });

        const crudos = Array.isArray(req.body?.documentos) ? req.body.documentos.map(d => String(d).trim()) : [];
        if (crudos.length === 0) {
            return res.status(400).json({ success: false, error: 'Debe enviar al menos un documento en "documentos".' });
        }
        const invalidos = crudos.filter(d => !REGEX_DOCUMENTO.test(d));
        if (invalidos.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Documentos con formato inválido (se espera CO-CAJA-CONSEC): ${invalidos.join(', ')}`
            });
        }
        const docs = [...new Set(crudos.map(normalizarDocumento))];
        if (docs.length > MAX_DOCUMENTOS) {
            return res.status(400).json({
                success: false,
                error: `Máximo ${MAX_DOCUMENTOS} documentos por solicitud (recibidos: ${docs.length}).`
            });
        }

        // Opciones opcionales: tipo de documento y fecha de inserción forzada (mismas reglas que syncVentas).
        let tipos, fechaDocto;
        try {
            tipos = normalizarTipos(req.body?.tipos);
            fechaDocto = validarFechaDocto(req.body?.fechaDocto);
            exigirDocumentos({ tipos, fechaDocto, hayDocumentos: docs.length > 0 });
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
        }
        const tiposInput = tipos.length === TIPOS_DOCUMENTO.length ? 'ambas' : tipos[0];

        // Flujo genéricos: solo CO 011/012 y fuente validada ('acumulado' por default).
        let fuente = 'acumulado';
        if (flujo === 'genericos') {
            const fuera = docs.filter(d => !COS_GENERICOS.includes(d.split('-')[0]));
            if (fuera.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: `El flujo genéricos solo acepta documentos de los CO ${COS_GENERICOS.join(' y ')}. Fuera de rango: ${fuera.join(', ')}`
                });
            }
            fuente = String(req.body?.fuente ?? 'acumulado').trim().toLowerCase() || 'acumulado';
            if (fuente !== 'vivo' && fuente !== 'acumulado') {
                return res.status(400).json({ success: false, error: `fuente inválida: "${fuente}". Valores permitidos: vivo | acumulado.` });
            }
        }

        console.log(`--- 🔄 Reproceso ${flujo === 'genericos' ? 'GENÉRICOS' : 'acumulado'} solicitado por ${req.user.email || req.user.id}: ${docs.length} documento(s): ${docs.join(', ')} | fuente=${fuente} | tipos=${tiposInput} | fecha de inserción=${fechaDocto || '(original)'} ---`);

        // GitHub concurrency conserva UNA sola corrida pendiente por grupo y cancela las pendientes
        // anteriores: un segundo dispatch podría cancelar en silencio un reproceso en cola.
        const { data: runs } = await axios.get(`${cfg.apiBase}/runs`, {
            headers: headersGithub(cfg.token),
            params: { per_page: 5 }
        });
        if ((runs?.workflow_runs || []).some(r => ESTADOS_RUN_ACTIVO.includes(r.status))) {
            return res.status(409).json({
                success: false,
                error: 'Ya hay una sincronización en curso o en cola. Intente de nuevo cuando termine.'
            });
        }

        // El workflow de genéricos tiene entorno=QA por default: aquí SIEMPRE se manda PROD.
        const inputs = flujo === 'genericos'
            ? {
                fuente,
                documentos: docs.join(','),
                tipos: tiposInput,
                fecha_docto: fechaDocto || '',
                entorno: 'PROD'
            }
            : {
                fuente: 'acumulado',
                documentos: docs.join(','),
                solo_hoy: 'false',
                tipos: tiposInput,
                fecha_docto: fechaDocto || ''
            };
        await axios.post(`${cfg.apiBase}/dispatches`, { ref: cfg.ref, inputs }, { headers: headersGithub(cfg.token) });

        res.status(202).json({ success: true, documentos: docs.length, actionsUrl: cfg.actionsUrl });
    } catch (error) {
        responderError(res, error);
    }
}

/**
 * GET /api/reprocesar-acumulado/estado?flujo=normal|genericos
 * Devuelve la última corrida manual (workflow_dispatch) del workflow del flujo pedido.
 */
async function estadoReprocesoAcumulado(req, res) {
    try {
        let flujo;
        try {
            flujo = normalizarFlujo(req.query?.flujo);
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
        }
        const cfg = configGithub(flujo);
        if (!cfg.token) return res.status(500).json({ success: false, error: ERROR_SIN_TOKEN });

        const { data } = await axios.get(`${cfg.apiBase}/runs`, {
            headers: headersGithub(cfg.token),
            params: { event: 'workflow_dispatch', per_page: 1 }
        });
        const r = data?.workflow_runs?.[0];
        res.status(200).json({
            success: true,
            run: r ? {
                id: r.id,
                status: r.status,
                conclusion: r.conclusion,
                html_url: r.html_url,
                created_at: r.created_at,
                updated_at: r.updated_at
            } : null
        });
    } catch (error) {
        responderError(res, error);
    }
}

module.exports = { requireSupabaseUser, reprocesarAcumulado, estadoReprocesoAcumulado };
