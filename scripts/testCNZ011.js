require('dotenv').config();
const { syncVentas } = require('../syncVentas');

(async () => {
    console.log("🧪 Prueba CO 011 — Solo CNZ");
    console.log("==========================================\n");
    try {
        const res = await syncVentas({ co: "011", soloCNZ: true, soloHoy: true, todas: true });
        console.log("\n✅ Prueba finalizada.");
        console.log(`Total: ${res.total} | OK: ${res.ok} | Fallo: ${res.fail}`);
        if (res.detalle && res.detalle.length > 0) {
            res.detalle.forEach(r => {
                const icon = r.ok ? '✅' : '❌';
                console.log(`  ${icon} [${r.tipo} ${r.consecutivo}] ${r.mensaje}`);
            });
        }
    } catch (e) {
        console.error("❌ Error:", e.message);
    }
})();
