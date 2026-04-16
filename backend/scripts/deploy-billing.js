#!/usr/bin/env node
/**
 * Compile + deploy OpsalisBilling to Sertone Demo L2 (chainId 845312).
 * After deployment, registers LoadTester serviceId -> revenue wallet.
 *
 * Env:
 *   RPC_URL              default https://demo.chainrpc.net
 *   DEPLOYER_PRIVATE_KEY required
 *   USDC_ADDRESS         default 0xb081d16D40e4e4c27D6d8564d145Ab2933037111
 *   LOADTESTER_WALLET    default 0x2BF40dfDDB7da7568EA508f3c7bd4168c1CFC431
 *
 * Writes the deployed address + ABI to stdout as JSON.
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://demo.chainrpc.net';
const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY;
const USDC = process.env.USDC_ADDRESS || '0xb081d16D40e4e4c27D6d8564d145Ab2933037111';
const LOADTESTER_WALLET = process.env.LOADTESTER_WALLET || '0x2BF40dfDDB7da7568EA508f3c7bd4168c1CFC431';

if (!DEPLOYER_PK) {
  console.error('DEPLOYER_PRIVATE_KEY env required');
  process.exit(1);
}

const source = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'OpsalisBilling.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'OpsalisBilling.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  }
};

console.error('[deploy] Compiling...');
const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors) {
  const fatal = out.errors.filter(e => e.severity === 'error');
  if (fatal.length) {
    console.error(JSON.stringify(fatal, null, 2));
    process.exit(1);
  }
}
const c = out.contracts['OpsalisBilling.sol']['OpsalisBilling'];
const abi = c.abi;
const bytecode = '0x' + c.evm.bytecode.object;

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.error('[deploy] chainId =', network.chainId.toString());
  if (network.chainId !== 845312n) {
    console.error('[deploy] WARNING: expected chainId 845312, got', network.chainId.toString());
  }
  const wallet = new ethers.Wallet(DEPLOYER_PK, provider);
  console.error('[deploy] deployer =', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.error('[deploy] deployer balance =', ethers.formatEther(bal), 'ETH');

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.error('[deploy] Deploying OpsalisBilling(', USDC, ')...');
  const contract = await factory.deploy(USDC);
  const tx = contract.deploymentTransaction();
  console.error('[deploy] tx =', tx.hash);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.error('[deploy] deployed at', addr);

  // Register LoadTester service
  const serviceId = ethers.keccak256(ethers.toUtf8Bytes('loadtester'));
  console.error('[deploy] serviceId(loadtester) =', serviceId);
  console.error('[deploy] registering revenue wallet', LOADTESTER_WALLET);
  const txReg = await contract.setServiceRevenueWallet(serviceId, LOADTESTER_WALLET);
  console.error('[deploy] register tx =', txReg.hash);
  const rc = await txReg.wait();
  console.error('[deploy] registered in block', rc.blockNumber);

  const result = {
    network: 'sertone-demo-l2',
    chainId: 845312,
    usdc: USDC,
    address: addr,
    deployer: wallet.address,
    deployTxHash: tx.hash,
    loadtester: {
      serviceId,
      revenueWallet: LOADTESTER_WALLET,
      registerTxHash: txReg.hash
    },
    productIds: {
      free: ethers.keccak256(ethers.toUtf8Bytes('free')),
      pro: ethers.keccak256(ethers.toUtf8Bytes('pro')),
      business: ethers.keccak256(ethers.toUtf8Bytes('business'))
    },
    abi
  };
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
