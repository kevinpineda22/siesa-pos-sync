// verLog.js
// Visor de trazabilidad: muestra el estado de las facturas procesadas.
//
// Uso:
//   node verLog.js                      -> resumen general
//   node verLog.js --pendientes         -> solo fallidas con causa
//   node verLog.js --consec 63870       -> historial de un consec específico
//   node verLog.js --categoria ITEM_INEXISTENTE
//   node verLog.js --maestras           -> regenera y muestra reporte de maestras

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

function leer(file) {
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

const args = process.argv.slice(2);
const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    return args[i + 1] || true;
};

const historial = leer(logger.FILE_PROCESADAS);
const pendientes = historial.filter(r => r.estado === 'FALLO');
const exitosas = historial.filter(r => r.estado === 'OK');

if (historial.length === 0) {
    console.log('ℹ️ No hay registros en logs/facturas_procesadas.json todavía.');
    process.exit(0);
}

// --- Filtro por consec específico ---
if (flag('--consec')) {
    const c = String(flag('--consec'));
    const matches = historial.filter(r => String(r.consec) === c);
    if (matches.length === 0) {
        console.log(`⚠️ No hay registros para consec ${c}.`);
        process.exit(0);
    }
    console.log(`\n📄 HISTORIAL CONSEC ${c}`);
    console.log('='.repeat(60));
    matches.forEach(m => {
        console.log(`\n  Tipo: ${m.tipo}   Estado: ${m.estado}   Intentos: ${m.intentos}`);
        console.log(`  Cliente: ${m.cliente_nit}   Fecha factura: ${m.fecha_factura}`);
        console.log(`  Items: ${m.items}   Neto: $${m.neto}`);
        console.log(`  Primera corrida: ${m.primera_corrida}`);
        console.log(`  Última corrida:  ${m.ultima_corrida}`);
        if (m.automatizaciones_aplicadas?.length) {
            console.log(`  Automatizaciones: ${m.automatizaciones_aplicadas.join(', ')}`);
        }
        if (m.error) {
            console.log(`  Error [${m.error.categoria}]: ${m.error.resumen}`);
            (m.error.detalle || []).slice(0, 5).forEach(d => {
                console.log(`     - ${d.f_detalle} (${d.f_valor})`);
            });
        }
    });
    console.log('');
    process.exit(0);
}

// --- Reporte de maestras ---
if (flag('--maestras')) {
    const file = logger.generarReporteMaestras();
    console.log(fs.readFileSync(file, 'utf8'));
    console.log(`\n📄 Guardado en: ${file}`);
    process.exit(0);
}

// --- Filtro por categoría ---
if (flag('--categoria')) {
    const cat = String(flag('--categoria')).toUpperCase();
    const fallidas = pendientes.filter(p => p.error && p.error.categoria === cat);
    console.log(`\n❌ FALLAS DE CATEGORÍA ${cat}: ${fallidas.length}`);
    console.log('='.repeat(60));
    fallidas.forEach(f => {
        console.log(`  [${f.tipo} ${f.consec}] cliente ${f.cliente_nit} - ${f.error.resumen}`);
    });
    console.log('');
    process.exit(0);
}

// --- Solo pendientes ---
if (flag('--pendientes')) {
    console.log(`\n❌ FACTURAS PENDIENTES (con error): ${pendientes.length}`);
    console.log('='.repeat(60));
    const porCat = {};
    pendientes.forEach(p => {
        const cat = p.error?.categoria || 'OTRO';
        if (!porCat[cat]) porCat[cat] = [];
        porCat[cat].push(p);
    });
    Object.keys(porCat).sort().forEach(cat => {
        console.log(`\n  ${cat} (${porCat[cat].length} facturas)`);
        porCat[cat].forEach(p => {
            console.log(`    - [${p.tipo} ${p.consec}] cliente ${p.cliente_nit} - intentos ${p.intentos} - ${p.error.resumen}`);
        });
    });
    console.log('');
    process.exit(0);
}

// --- Resumen general (default) ---
console.log('\n📊 ESTADO GENERAL DE TRAZABILIDAD');
console.log('='.repeat(60));
console.log(`   Total registradas:    ${historial.length}`);
console.log(`   ✅ Procesadas OK:     ${exitosas.length}`);
console.log(`   ❌ Pendientes/Fallo:  ${pendientes.length}`);

// Distribución CFE vs CNC.
const cfeOk = exitosas.filter(r => r.tipo === 'CFE').length;
const cncOk = exitosas.filter(r => r.tipo === 'CNC').length;
const cfeFail = pendientes.filter(r => r.tipo === 'CFE').length;
const cncFail = pendientes.filter(r => r.tipo === 'CNC').length;
console.log(`   ├─ CFE: ${cfeOk} OK / ${cfeFail} fallo`);
console.log(`   └─ CNC: ${cncOk} OK / ${cncFail} fallo`);

if (pendientes.length > 0) {
    console.log('\n❌ FALLAS AGRUPADAS POR CAUSA');
    console.log('-'.repeat(60));
    const porCat = {};
    pendientes.forEach(p => {
        const cat = p.error?.categoria || 'OTRO';
        if (!porCat[cat]) porCat[cat] = [];
        porCat[cat].push(p);
    });
    Object.keys(porCat).sort((a, b) => porCat[b].length - porCat[a].length).forEach(cat => {
        const lista = porCat[cat];
        const consecs = [...new Set(lista.map(l => l.consec))];
        console.log(`   ${cat} (${lista.length} registros, ${consecs.length} consec únicos)`);
        consecs.slice(0, 5).forEach(c => console.log(`     - ${c}`));
        if (consecs.length > 5) console.log(`     ... y ${consecs.length - 5} más`);
    });
}

console.log('\nℹ️ Comandos:');
console.log('   node verLog.js --pendientes               (detalle de fallidas)');
console.log('   node verLog.js --consec <NUM>             (historial de un consec)');
console.log('   node verLog.js --categoria <CAT>          (filtrar por causa)');
console.log('   node verLog.js --maestras                 (reporte para Siesa)\n');
