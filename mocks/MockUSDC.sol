pragma solidity ^0.6.0;

// import "../contracts/interface/IERC20.sol";
// import "../contracts/upgradeable/Ownable.sol";
// import "../contracts/lib/SafeMath.sol";
import "../interface/IERC20.sol";
import "../upgradeable/Ownable.sol";
import "../lib/SafeMath.sol";

contract MockUSDC is IERC20, OpenZeppelinUpgradesOwnable {
    using SafeMath for uint256;

    uint256 public constant FAUCET_AMOUNT = 1e6 * 100;
    uint256 private _totalSupply = 10000000000000000000000000000000000;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    constructor() public {
        // Initialize supply to owner
        _balances[owner()] = _totalSupply;
    }

    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function name() external override view returns (string memory) {
        return "USD Coin";
    }

    function symbol() external override view returns (string memory) {
        return "USDC";
    }

    function decimals() external override view returns (uint8) {
        return 6;
    }

    /**
     * Mints tokens to the sender
     */
    function mint() external returns (bool) {
        _balances[msg.sender] = _balances[msg.sender].add(FAUCET_AMOUNT);
        emit Transfer(address(0), msg.sender, _balances[msg.sender]);

        return true;
    }

    /**
     * @dev Moves `amount` tokens from the caller's account to `recipient`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    // prettier-ignore
    function transfer(address recipient, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    /**
     * @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    // prettier-ignore
    function approve(address spender, uint256 amount) external override returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    /**
     * @dev Moves `amount` tokens from `sender` to `recipient` using the
     * allowance mechanism. `amount` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    // prettier-ignore
    function transferFrom(address sender, address recipient, uint256 amount) external override returns (bool) {
        if (sender != msg.sender) {
            _approve(sender, msg.sender, _allowances[sender][msg.sender].sub(amount, "ERC20: insufficient allowance"));
        }
        _transfer(sender, recipient, amount);
        return true;
    }

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    // prettier-ignore
    function allowance(address owner, address spender) external override view returns (uint256) {
        return _allowances[owner][spender];
    }

    /**
     * @dev Returns the amount of tokens in existence.
     */
    // prettier-ignore
    function totalSupply() external override view returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev Returns the amount of tokens owned by `account`.
     */
    // prettier-ignore
    function balanceOf(address account) external override view returns (uint256) {
        return _balances[account];
    }

    /**
     * @dev internal transfer function
     */
    function _transfer(address sender, address recipient, uint256 amount) internal {
        require(sender != address(0), "ERC20: transfer from zero address");
        require(recipient != address(0), "ERC20: send to zero address");

        _balances[sender] = _balances[sender].sub(amount, "ERC20: transfer exceeds balance");
        _balances[recipient] = _balances[recipient].add(amount);
        emit Transfer(sender, recipient, _balances[sender]);
    }

    /**
     * @dev internal approval function
     */
    function _approve(address owner, address spender, uint256 amount) internal {
        require(owner != address(0), "ERC20: approve owner of zero address");
        require(spender != address(0), "ERC20: approve spender of zero address");

        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }
}
