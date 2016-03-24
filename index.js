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

  // <peerPublicKey>: <totalSent>
  this.peersTotalSent = {}

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
    wire.wt_ilp.on('request', function () {
      debug('wt_ilp got request')
      wire.wt_ilp.sendLowBalance(0)
    })
    wire.wt_ilp.on('payment_request', function (peerReportedBalance) {
      debug('Got payment request. Peer says our balance is: %s', peerReportedBalance)
      _this.checkSendPayment({
        peerPublicKey: wire.wt_ilp.peerPublicKey,
        peerAccount: wire.wt_ilp.peerAccount,
        infoHash: torrent.infoHash,
        bytesDownloaded: wire.downloaded
      })
    })
    wire.wt_ilp.on('warning', function (err) {
      debug('Error', err)
    })

    wire.wt_ilp.forceChoke()
  })
}

WebTorrentIlp.prototype.checkSendPayment = function (params) {
  const _this = this
  const infoHash = params.infoHash
  const peerPublicKey = params.peerPublicKey
  // TODO make sure we're checking they're actually sending us pieces we want
  const bytesDownloaded = params.bytesDownloaded

  if (!this.peersTotalSent[peerPublicKey]) {
    this.peersTotalSent[peerPublicKey] = new BigNumber(0)
  }

  const maxCostPerByte = '0.000000001'

  const costPerByte = bytesDownloaded > 0 ? this.peersTotalSent[peerPublicKey].div(bytesDownloaded) : new BigNumber(0)

  debug('checkSendPayment bytesDownloaded: %s costPerByte: %s', bytesDownloaded, costPerByte.toString())
  
  if (costPerByte.lessThan(maxCostPerByte)) {
    const sourceAmount = _this.price.times(10)

    // Track how much we've sent to them
    this.peersTotalSent[peerPublicKey] = this.peersTotalSent[peerPublicKey].plus(sourceAmount)

    const paymentParams = {
      sourceAmount: sourceAmount.toString(),
      destinationAccount: params.peerAccount,
      destinationMemo: {
        public_key: _this.publicKey
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
        debug('Error sending payment', err)
      })
  } else {
    debug('Not sending any more money, our cost per byte with this peer is already: %s', costPerByte.toString())
  }
}

WebTorrentIlp.prototype._handleIncomingPayment = function (payment) {
  debug('got incoming payment %o', payment)
}

module.exports = WebTorrentIlp
for (let key in WebTorrent) {
  module.exports[key] = WebTorrent[key]
}
