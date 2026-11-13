// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Planted contracts for the reader/agent tests. Every behaviour here is deliberate: test/fixtures/expected.json
// states the answer to all 13 Control Map keys for each deployed scenario.

contract Owned {
    address public owner;
    bool internal inited;
    function init(address o) external { require(!inited, "inited"); inited = true; owner = o; }
    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }
    function renounceOwnership() external onlyOwner { owner = address(0); }
}

/// Owner chain stub: a contract whose owner() points on (stands in for a multisig / timelock).
contract Multisig { address public owner; constructor(address o) { owner = o; } }

/// Plain contract with an owner and no upgrade path, not a token.
contract PlainOwned { address public owner; uint256 public n; constructor(address o) { owner = o; } function setN(uint256 x) external { require(msg.sender == owner); n = x; } }

/// Plain contract that exposes no owner().
contract NoOwner { uint256 public n; function setN(uint256 x) external { n = x; } }

/// Same as PlainOwned but initialised after cloning (for EIP-1167 clones).
contract CloneTarget is Owned { uint256 public n; function setN(uint256 x) external onlyOwner { n = x; } }

abstract contract Tok {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    function _move(address f, address t, uint256 a) internal virtual { balanceOf[f] -= a; balanceOf[t] += a; }
    function transfer(address t, uint256 a) external virtual returns (bool) { _move(msg.sender, t, a); return true; }
}

/// Anyone can mint, no cap.
contract OpenMint is Tok { function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; } }

/// Owner mint, lifetime cap that burning does not reopen.
contract CappedMint is Owned, Tok {
    uint256 public constant CAP = 1_000_000e18; uint256 public minted;
    function mint(address to, uint256 a) external onlyOwner { require(minted + a <= CAP, "cap"); minted += a; balanceOf[to] += a; totalSupply += a; }
    function burn(uint256 a) external { balanceOf[msg.sender] -= a; totalSupply -= a; }
}

/// Supply fixed at initialisation; the owner can pause transfers.
contract PausableTok is Owned, Tok {
    bool public paused;
    function seed(uint256 a) external onlyOwner { require(totalSupply == 0); balanceOf[owner] = a; totalSupply = a; } // one-shot genesis mint
    function setPaused(bool p) external onlyOwner { paused = p; }
    function _move(address f, address t, uint256 a) internal override { require(!paused, "paused"); super._move(f, t, a); }
}

/// Owner can change a transfer fee.
contract TaxTok is Owned, Tok {
    uint256 public feeBps; address public feeTo;
    function setFee(uint256 b, address to) external onlyOwner { feeBps = b; feeTo = to; }
    function _move(address f, address t, uint256 a) internal override {
        uint256 fee = a * feeBps / 10_000; balanceOf[f] -= a; balanceOf[t] += a - fee; balanceOf[feeTo] += fee;
    }
}

/// Owner mint, no cap, but every mint is queued for two days first.
contract TimelockMint is Owned, Tok {
    uint256 public constant DELAY = 2 days;
    mapping(bytes32 => uint256) public eta;
    function queueMint(address to, uint256 a) external onlyOwner { eta[keccak256(abi.encode(to, a))] = block.timestamp + DELAY; }
    function executeMint(address to, uint256 a) external onlyOwner {
        bytes32 id = keccak256(abi.encode(to, a)); uint256 e = eta[id]; require(e != 0 && block.timestamp >= e, "early"); delete eta[id];
        balanceOf[to] += a; totalSupply += a;
    }
}

abstract contract UUPSBase is Owned {
    bytes32 internal constant IMPL = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    function proxiableUUID() external pure returns (bytes32) { return IMPL; }
    function upgradeTo(address impl) external onlyOwner { assembly { sstore(IMPL, impl) } }
}
contract UUPSVault is UUPSBase { uint256 public n; function setN(uint256 x) external onlyOwner { n = x; } }
contract UUPSPausable is UUPSBase, Tok {
    bool public paused;
    function setPaused(bool p) external onlyOwner { paused = p; }
    function _move(address f, address t, uint256 a) internal override { require(!paused, "paused"); super._move(f, t, a); }
}
contract UUPSTimelockMint is UUPSBase, Tok {
    mapping(bytes32 => uint256) public eta;
    function queueMint(address to, uint256 a) external onlyOwner { eta[keccak256(abi.encode(to, a))] = block.timestamp + 2 days; }
    function executeMint(address to, uint256 a) external onlyOwner {
        bytes32 id = keccak256(abi.encode(to, a)); uint256 e = eta[id]; require(e != 0 && block.timestamp >= e, "early"); delete eta[id];
        balanceOf[to] += a; totalSupply += a;
    }
}

contract ERC1967Proxy {
    bytes32 internal constant IMPL = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    constructor(address impl, bytes memory data) { assembly { sstore(IMPL, impl) } if (data.length > 0) { (bool ok,) = impl.delegatecall(data); require(ok); } }
    fallback() external payable { assembly { let i := sload(IMPL) calldatacopy(0, 0, calldatasize()) let r := delegatecall(gas(), i, 0, calldatasize(), 0, 0) returndatacopy(0, 0, returndatasize()) switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) } } }
}

contract ProxyAdmin { address public owner; constructor(address o) { owner = o; }
    function upgrade(address proxy, address impl) external { require(msg.sender == owner); TransparentProxy(payable(proxy)).upgradeTo(impl); } }

contract TransparentProxy {
    bytes32 internal constant IMPL = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    constructor(address impl, address admin, bytes memory data) { assembly { sstore(IMPL, impl) sstore(ADMIN, admin) } if (data.length > 0) { (bool ok,) = impl.delegatecall(data); require(ok); } }
    function upgradeTo(address impl) external { address a; assembly { a := sload(ADMIN) } require(msg.sender == a); assembly { sstore(IMPL, impl) } }
    fallback() external payable { address a; assembly { a := sload(ADMIN) } require(msg.sender != a, "admin cannot fallback");
        assembly { let i := sload(IMPL) calldatacopy(0, 0, calldatasize()) let r := delegatecall(gas(), i, 0, calldatasize(), 0, 0) returndatacopy(0, 0, returndatasize()) switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) } } }
}

contract UpgradeableBeacon { address public owner; address public implementation; constructor(address o, address impl) { owner = o; implementation = impl; }
    function upgradeTo(address impl) external { require(msg.sender == owner); implementation = impl; } }

contract BeaconProxy {
    bytes32 internal constant BEACON = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    constructor(address beacon, bytes memory data) { assembly { sstore(BEACON, beacon) } if (data.length > 0) { (bool ok,) = UpgradeableBeacon(beacon).implementation().delegatecall(data); require(ok); } }
    fallback() external payable { address b; assembly { b := sload(BEACON) } address i = UpgradeableBeacon(b).implementation();
        assembly { calldatacopy(0, 0, calldatasize()) let r := delegatecall(gas(), i, 0, calldatasize(), 0, 0) returndatacopy(0, 0, returndatasize()) switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) } } }
}

/// Code an EOA delegates to with EIP-7702: batch execution, no owner(), no upgrade function.
contract SimpleWallet { function execute(address to, uint256 v, bytes calldata d) external returns (bytes memory r) { require(msg.sender == address(this)); (bool ok, bytes memory o) = to.call{value: v}(d); require(ok); return o; } }
