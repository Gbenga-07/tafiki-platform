// Investment terms and the stock each unit buys. Stored in settings, editable from the console.
const { getSetting, putSetting, DEFAULTS } = require('./settings');
DEFAULTS.terms = { unitPrice: 2000000, unitsPerPackage: 40, targetPerCycle: 0.0833333, cycleDays: 90, coverFloor: 1.1, reservePct: 0.1, capPct: 0.35, minHoldMonths: 12, reservationHours: 48, companyPct: 0.101, citRate: 0.3, devLevy: 0.04 };
DEFAULTS.unit_package = { items: [
  { sku: 'garri-5', name: 'Garri', brand: 'FOODCORE', size: '5 kg', bags: 500, cost: 2000 },
  { sku: 'elubo-5', name: 'Elubo (Yam Flour)', brand: 'FOODCORE', size: '5 kg', bags: 200, cost: 5000 },
] };
DEFAULTS.escrow = { bank: '[Trustee bank]', accountNumber: '[Escrow account no.]', accountName: 'Tafiki Escrow · FOODCORE Units' };
const getTerms = () => getSetting('terms');
const getUnitPackage = () => getSetting('unit_package');
const packValue = (p) => p.items.reduce((a, i) => a + i.bags * i.cost, 0);
module.exports = { getTerms, getUnitPackage, packValue, putSetting, getSetting };
