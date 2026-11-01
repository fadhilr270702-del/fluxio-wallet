/**
 * Minimal ERC-20 deploy/transfer admin operations for LOCAL DEV/DEMO USE
 * ONLY — used by scripts/erc20-local-demo.mjs and tokenService's
 * local-integration test, never by anything else in this repo. Same
 * "reachable only via a direct relative import, not the package's
 * exports map" rule as splTokenAdmin.js — see that file's header comment
 * for the full reasoning (applies here verbatim, EVM side).
 *
 * The contract is compiled from source at call time via `solc` (a
 * devDependency of this package, used nowhere else) rather than a
 * hand-copied/hallucinated bytecode blob — real compilation is the only
 * way to be sure the deployed bytecode actually matches the source below.
 * The source itself is deliberately self-contained (no OpenZeppelin
 * import) — a single-file input keeps solc's `sources` map trivial (no
 * import-resolution callback needed) and keeps the whole contract
 * readable in one place for anyone auditing what actually gets deployed
 * to their local anvil node.
 *
 * This is NOT an audited production ERC-20 — no SafeMath needed (Solidity
 * >=0.8 has built-in overflow checks), no access control beyond a fixed
 * initial mint to the deployer, no pausability. It implements just enough
 * of the standard (transfer/balanceOf/decimals/symbol/name/totalSupply/
 * approve/allowance/transferFrom + Transfer/Approval events) for
 * tokenService.js's eth_call balanceOf() path to recognize it like any
 * other ERC-20.
 */
import solc from 'solc';
import { ContractFactory, Wallet, JsonRpcProvider } from 'ethers';

const CONTRACT_NAME = 'FluxioDemoToken';
const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal ERC-20 for local demo/testing only — NOT audited, NOT for
/// production use. See packages/services/erc20Admin.js's header comment.
contract ${CONTRACT_NAME} {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _initialSupply) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        totalSupply = _initialSupply;
        balanceOf[msg.sender] = _initialSupply;
        emit Transfer(address(0), msg.sender, _initialSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "ERC20: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "ERC20: transfer to zero address");
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= value, "ERC20: insufficient balance");
        balanceOf[from] = fromBalance - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
`;

/** Compiles SOURCE once per process (solc is deterministic — same input always the same output, no reason to recompile per call) and caches the {abi, bytecode} pair. */
let compiledCache = null;
function compile() {
  if (compiledCache) return compiledCache;

  const input = {
    language: 'Solidity',
    sources: { 'FluxioDemoToken.sol': { content: SOURCE } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    throw new Error(`Failed to compile ${CONTRACT_NAME}:\n${errors.map((e) => e.formattedMessage).join('\n')}`);
  }

  const contract = output.contracts['FluxioDemoToken.sol'][CONTRACT_NAME];
  compiledCache = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
  return compiledCache;
}

/**
 * Deploys a fresh FluxioDemoToken (minting `initialSupplyRaw` to the
 * deployer) and transfers `transferAmountRaw` of it to `recipientAddress`
 * — both raw smallest-unit amounts (BigInt), matching how tokenService.js
 * itself always deals in raw amounts, never a human decimal string.
 *
 * @param {{
 *   rpcUrl: string,
 *   deployerPrivateKey: string,
 *   recipientAddress: string,
 *   name: string,
 *   symbol: string,
 *   decimals: number,
 *   initialSupplyRaw: bigint,
 *   transferAmountRaw: bigint
 * }} params
 * @returns {Promise<{ contractAddress: string, transferTxHash: string }>}
 */
export async function deployAndTransferDemoErc20({
  rpcUrl,
  deployerPrivateKey,
  recipientAddress,
  name,
  symbol,
  decimals,
  initialSupplyRaw,
  transferAmountRaw
}) {
  const { abi, bytecode } = compile();

  const provider = new JsonRpcProvider(rpcUrl);
  const deployer = new Wallet(deployerPrivateKey, provider);

  // Nonces are assigned explicitly from a single up-front read rather than
  // trusting ethers' automatic per-call "pending" nonce lookup for the
  // second (transfer) transaction — confirmed directly against a real
  // anvil node while building this script that the automatic path can
  // submit the transfer with the SAME nonce the deploy transaction just
  // used (rejected as "nonce too low"/NONCE_EXPIRED), even after properly
  // awaiting the deploy's own receipt first. Fetching both nonces once,
  // up front, sidesteps whatever staleness causes that race.
  const baseNonce = await provider.getTransactionCount(deployer.address, 'latest');

  const factory = new ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(name, symbol, decimals, initialSupplyRaw, { nonce: baseNonce });
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  const tx = await contract.transfer(recipientAddress, transferAmountRaw, { nonce: baseNonce + 1 });
  const receipt = await tx.wait();

  return { contractAddress, transferTxHash: receipt.hash };
}
