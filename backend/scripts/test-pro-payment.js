#!/usr/bin/env node
/**
 * E2E paid-tier test:
 *   1. Approve USDC for OpsalisBilling
 *   2. Call pay(serviceId, pro, 20 USDC)
 *   3. Return txHash for the LoadTester backend to verify
 */
const { ethers } = require('ethers');

const RPC = process.env.RPC_URL || 'http://192.99.9.106:30846';
const CUSTOMER_PK = process.env.CUSTOMER_PK; // testbed customer USDC wallet
const BILLING = process.env.BILLING || '0xCEfD64724E6EAbD3372188d3b558b1e74dD27Bc6';
const USDC = process.env.USDC || '0xb081d16D40e4e4c27D6d8564d145Ab2933037111';
const SERVICE_ID = '0x39e319d50c7360338f5104d5ff8f943e6a8aa90173b926382f58b02d99673538'; // keccak256("loadtester")
const PRO_PRODUCT_ID = '0x3b61c0fe064f998f32a3661de12f8ef66f69d3eed20df1d23c30fc57463ab9b2';
const AMOUNT = 20_000_000n; // 20 USDC (6 decimals)

const usdcAbi = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];
const billingAbi = ['function pay(bytes32,bytes32,uint256)'];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(CUSTOMER_PK, provider);
  console.error('customer:', wallet.address);

  const usdc = new ethers.Contract(USDC, usdcAbi, wallet);
  const bal = await usdc.balanceOf(wallet.address);
  console.error('balance:', (bal / 1_000_000n).toString(), 'USDC');

  console.error('[1/2] approve...');
  const approveTx = await usdc.approve(BILLING, AMOUNT);
  console.error('  tx:', approveTx.hash);
  await approveTx.wait();

  console.error('[2/2] pay...');
  const billing = new ethers.Contract(BILLING, billingAbi, wallet);
  const payTx = await billing.pay(SERVICE_ID, PRO_PRODUCT_ID, AMOUNT);
  console.error('  tx:', payTx.hash);
  const rc = await payTx.wait();
  console.error('  block:', rc.blockNumber);
  console.log(payTx.hash);
})().catch(e => { console.error(e); process.exit(1); });
