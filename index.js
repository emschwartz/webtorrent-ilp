'use strict'

const WebTorrent = require('webtorrent')
const inherits = require('inherits')
const wt_ilp = require('wt_ilp')
const moment = require('moment')
const debug = require('debug')('WebTorrentIlp')
const BigNumber = require('bignumber.js')
const sendPayment = require('five-bells-sender')
const WalletClient = require('./src/walletClient').WalletClient

inherits(WebTorrentIlp, WebTorrent)

function WebTorrentIlp (opts) {
  const _this = this

  WebTorrent.call(this, opts)

  this.address = opts.address
  this.password = opts.password
  this.price = new BigNumber(opts.price)
  this.publicKey = opts.publicKey

  this.walletClient = new WalletClient({
    address: opts.address,
    password: opts.password
  })
  this.walletClient.connect()
  this.walletClient.on('incoming', this._handleIncomingPayment.bind(this))
  this.walletClient.on('outgoing', this._handleOutgoingPayment.bind(this))

  // <peerPublicKey>: <totalSent>
  this.peersTotalSent = {}
  // <peerPublicKey>: <balance>
  this.peerBalances = {}

  // Catch the torrents returned by the following methods to make them
  // a) wait for the walletClient to be ready and
  // b) use the wt_ilp extension
  const functionsToCallOnTorrent = [this._waitForWalletClient.bind(this), this._setupWtIlp.bind(this)]
  this._catchTorrent('seed', functionsToCallOnTorrent)
  this._catchTorrent('add', functionsToCallOnTorrent)
  this._catchTorrent('download', functionsToCallOnTorrent)
}

WebTorrentIlp.prototype._catchTorrent = function (fnName, functionsToCall) {
  const _this = this
  const oldFn = this[fnName]
  this[fnName] = function () {
    const torrent = oldFn.apply(_this, arguments)
    torrent.on('listening', function () {
      debug('torrent is listening')
    })
    for (let fn of functionsToCall) {
      fn(torrent)
    }
    return torrent
  }
}

WebTorrentIlp.prototype._waitForWalletClient = function (torrent) {
  const _this = this
  // Torrent._onParsedTorrent is the function that starts the swarm
  // We want it to wait until the walletClient is ready
  // TODO find a less hacky way of delaying the torrent's start
  const _onParsedTorrent = torrent._onParsedTorrent
  torrent._onParsedTorrent = function () {
    const args = arguments
    if (_this.walletClient.ready) {
      _onParsedTorrent.apply(torrent, args)
    } else {
      _this.walletClient.once('ready', function () {
        _onParsedTorrent.apply(torrent, args)
      })
    }
  }
}

WebTorrentIlp.prototype._setupWtIlp = function (torrent) {
  const _this = this
  // TODO keep track of how much we send to each peer per torrent
  torrent.totalCost = new BigNumber(0)
  torrent.totalEarned = new BigNumber(0)

  torrent.on('wire', function (wire) {
    wire.use(wt_ilp({
      account: _this.walletClient.account,
      price: _this.price,
      publicKey: _this.publicKey
    }))
    wire.wt_ilp.on('ilp_handshake', function (handshake) {
      debug('Got extended handshake', handshake)
      // wire.wt_ilp.unchoke()
    })

    // Charge peers for requesting data from us
    wire.wt_ilp.on('request', _this._chargePeerForRequest.bind(_this, wire, torrent))

    // Pay peers who we are downloading from
    wire.wt_ilp.on('payment_request', _this._payPeer.bind(_this, wire, torrent))

    wire.wt_ilp.on('warning', function (err) {
      debug('Error', err)
    })

    wire.wt_ilp.forceChoke()
  })

  torrent.on('download', function () {
    debug('torrent total cost: ' + torrent.totalCost.toString())
  })
}

WebTorrentIlp.prototype._chargePeerForRequest = function (wire, torrent) {
  debug('wt_ilp got request')
  const peerPublicKey = wire.wt_ilp.peerPublicKey
  const peerBalance = this.peerBalances[peerPublicKey]
  if (peerBalance && peerBalance.greaterThan(this.price)) {
    // TODO charge per byte (or megabyte) instead of per chunk
    debug('charging peer ' + peerPublicKey + ' ' + this.price.toString() + ' for request')
    this.peerBalances[wire.wt_ilp.peerPublicKey] = peerBalance.minus(this.price)
    torrent.totalEarned = torrent.totalEarned.plus(this.price)
    wire.wt_ilp.unchoke()
  } else {
    wire.wt_ilp.sendLowBalance(0)
    wire.wt_ilp.forceChoke()
  }
}

WebTorrentIlp.prototype._payPeer = function (wire, torrent) {
  const _this = this
  const infoHash = torrent.infoHash
  const peerPublicKey = wire.wt_ilp.peerPublicKey
  const peerAccount = wire.wt_ilp.peerAccount
  // TODO make sure we're checking they're actually sending us pieces we want
  const bytesDownloaded = wire.downloaded

  if (!this.peersTotalSent[peerPublicKey]) {
    this.peersTotalSent[peerPublicKey] = new BigNumber(0)
  }

  // TODO make the cost calculation more intelligent so we actually download the whole file from the peer @tomorrow
  const maxCostPerByte = '0.000000001'

  const costPerByte = bytesDownloaded > 0 ? this.peersTotalSent[peerPublicKey].div(bytesDownloaded) : new BigNumber(0)

  debug('checkSendPayment bytesDownloaded: %s costPerByte: %s', bytesDownloaded, costPerByte.toString())
  
  if (costPerByte.lessThan(maxCostPerByte)) {
    const sourceAmount = _this.price.times(10)

    // Track how much we've sent to them
    this.peersTotalSent[peerPublicKey] = this.peersTotalSent[peerPublicKey].plus(sourceAmount)

    // Track torrent total cost
    torrent.totalCost = torrent.totalCost.plus(sourceAmount)

    const paymentParams = {
      sourceAmount: sourceAmount.toString(),
      destinationAccount: peerAccount,
      destinationMemo: {
        public_key: _this.publicKey
      },
      sourceMemo: {
        public_key: peerPublicKey
      }
    }
    debug('About to send payment: %o', paymentParams)
    this.walletClient.sendPayment(paymentParams)
      .then(function (result) {
        debug('Sent payment', result)
      })
      .catch(function (err) {
        // If there was an error, subtract the amount from what we've paid them
        // TODO make sure we actually didn't pay them anything
        _this.peersTotalSent[peerPublicKey] = _this.peersTotalSent[peerPublicKey].minus(sourceAmount)
        torrent.totalCost = torrent.totalCost.minus(sourceAmount)
        debug('Error sending payment', err.stack)
      })
  } else {
    debug('Not sending any more money, our cost per byte with this peer is already: %s', costPerByte.toString())
  }
}

WebTorrentIlp.prototype._handleIncomingPayment = function (credit) {
  if (credit.memo && typeof credit.memo === 'object') {
    const peerPublicKey = credit.memo.public_key
    if (!peerPublicKey) {
      return
    }
    debug('crediting peer: ' + peerPublicKey + ' for payment of: ' + credit.amount)
    const previousBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)
    const newBalance = previousBalance.plus(credit.amount)
    this.peerBalances[peerPublicKey] = newBalance
  }
}

WebTorrentIlp.prototype._handleOutgoingPayment = function (debit) {
  // debug('xxx got outgoing debit %o', debit)
}

module.exports = WebTorrentIlp
for (let key in WebTorrent) {
  module.exports[key] = WebTorrent[key]
}
