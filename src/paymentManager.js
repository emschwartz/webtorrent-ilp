'use strict'

const BigNumber = require('bignumber.js')
const WalletClient = require('./walletClient').WalletClient

/**
 * Manage payments for torrents
 * @param {String} opts.walletAddress
 * @param {String} opts.walletPassword
 * @param {String|Number} opts.price Price per chunk
 */
function PaymentManager (opts) {
  this.price = new BigNumber(opts.price)

  this._walletClient = new WalletClient({
    address: opts.walletAddress,
    password: opts.walletPassword,
    walletUri: opts.walletUri
  })
  this.ready = false
  this.account = null

  // <public_key>: <balance>
  this._peerBalances = {}
}

PaymentManager.prototype.connect = function () {
  const _this = this
  this._walletClient.connect()
  this._walletClient.on('ready', function () {
    _this.ready = true
    _this.account = _this._walletClient.account
    _this._walletClient.on('incomingCredit', _this._handleIncomingCredit.bind(_this))
  })
}

PaymentManager.prototype.disconnect = function () {
  this._walletClient.disconnect()
}

PaymentManager.prototype.getBalance = function (peerPublicKey) {
  if (this._peerBalances[peerPublicKey]) {
    return this._peerBalances[peerPublicKey]
  } else {
    return new BigNumber(0)
  }
}

PaymentManager.prototype.hasSufficientBalance = function (params) {
  if (!params.peerPublicKey) {
    return false
  }
  return this.getBalance(params.peerPublicKey).greaterThanOrEqualTo(this.price)
}

PaymentManager.prototype.chargeRequest = function (params) {
  if (this.hasSufficientBalance(params)) {
    this._peerBalances[params.peerPublicKey] = this._peerBalances[params.peerPublicKey].minus(this.price)
    console.log('Charging peer ' + params.peerPublicKey + ' ' + this.price + ' for request. New Balance: ' + this._peerBalances[params.peerPublicKey])
    return true
  } else {
    console.log('Peer ' + params.peerPublicKey + ' has insufficient balance: ' + this._peerBalances[params.peerPublicKey])
    return false
  }
}

PaymentManager.prototype.handlePaymentRequest = function (params) {
  // TODO check if we actually want to send the payment
  console.log('handlePaymentRequest', params)
  this._walletClient.sendPayment(params)
}

PaymentManager.prototype._handleIncomingCredit = function (credit) {
  // TODO don't check for string memos once https://github.com/interledger/five-bells-shared/pull/111 is merged
  let memo
  if (typeof credit.memo === 'string') {
    try {
      memo = JSON.parse(credit.memo)
    } catch (e) {
      console.log('Malformed memo', memo)
    }
  } else if (typeof credit.memo === object) {
    memo = credit.memo
  }

  if (memo.public_key) {
    if (!this._peerBalances[memo.public_key]) {
      this._peerBalances[memo.public_key] = new BigNumber(0)
    }

    this._peerBalances[memo.public_key] = this._peerBalances[memo.public_key].plus(credit.amount)

    console.log('Crediting peer for payment of ' + credit.amount + ' balance now: ' + this._peerBalances[memo.public_key])
  } else {
    console.log('Got unrelated payment notification', credit)
  }
}

exports.PaymentManager = PaymentManager
