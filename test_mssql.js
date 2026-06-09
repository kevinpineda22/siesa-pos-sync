require('dotenv').config();
const sql = require('mssql');

const config = {
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || 'password',
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_DATABASE || 'master',
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

async function testQuery() {
    try {
        console.log("Connecting to MSSQL...");
        await sql.connect(config);
        
        console.log("Querying merkahorro_venta_pos_dev...");
        const result = await sql.query`SELECT TOP 1 * FROM merkahorro_venta_pos_dev`;
        
        if (result.recordset && result.recordset.length > 0) {
            console.log("KEYS RETURNED:");
            console.log(Object.keys(result.recordset[0]));
        } else {
            console.log("No records found in merkahorro_venta_pos_dev");
        }
    } catch (err) {
        console.error("SQL Error:", err.message);
    } finally {
        await sql.close();
    }
}

testQuery();
