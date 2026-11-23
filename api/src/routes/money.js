// Members: identity check, wallet, withdrawals, redemptions.
const express = require('express');
const { getDb } = require('../db');
const { requireUser } = require('../lib/auth');
const kyc = require('../lib/kyc');
const payouts = require('../lib/payouts');
const r = express.Router();
r.use(requireUser);
r.post('/kyc/start', async (req, res) => res.json(await kyc.start(req.user, (req.body && req.body.product) || 'biometric_kyc', req.body && req.body.idType)));
r.get('/kyc', async (req, res) => res.json({ status: req.user.kyc_status, checks: await getDb()('kyc_checks').where({ user_id: req.user.id }).orderBy('created_at', 'desc').select('product', 'id_type', 'status', 'result_text', 'created_at', 'completed_at') }));
r.get('/wallet', async (req, res) => res.json({ balance: await payouts.walletBalance(req.user.id), transactions: await getDb()('wallet_tx').where({ user_id: req.user.id }).orderBy('created_at', 'desc').limit(500) }));
r.post('/wallet/withdrawals', async (req, res) => res.status(201).json({ withdrawal: await payouts.requestWithdrawal(req.user, req.body && req.body.amount) }));
r.get('/wallet/withdrawals', async (req, res) => res.json({ withdrawals: await getDb()('withdrawals').where({ user_id: req.user.id }).orderBy('created_at', 'desc') }));
r.post('/holdings/:id/redeem', async (req, res) => res.status(201).json({ redemption: await payouts.requestRedemption(req.user, req.params.id) }));
r.post('/holdings/:id/redeem/cancel', async (req, res) => { await payouts.cancelRedemption(req.user, req.params.id); res.json({ ok: true }); });
module.exports = r;
