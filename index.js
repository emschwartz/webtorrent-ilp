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
  this.price = new BigNumber(opts.price) // price per byte
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
  // <peerPublicKey>: <[wire, wire]>
  this.peerWires = {}

  // Catch the torrents returned by the following methods to make them
  // a) wait for the walletClient to be ready and
  // b) use the wt_ilp extension
  const functionsToCallOnTorrent = [this._waitForWalletClient.bind(this), this._setupWtIlp.bind(this)]
  this._catchTorrent('seed', functionsToCallOnTorrent)
  this._catchTorrent('download', functionsToCallOnTorrent)
  // client.add is an alias for client.download
  this.add = this.download
}

WebTorrentIlp.prototype._catchTorrent = function (fnName, functionsToCall) {
  const _this = this
  const oldFn = this[fnName]
  this[fnName] = function () {
    const torrent = oldFn.apply(_this, arguments)
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
  torrent.spentPerPeer = {}

  torrent.on('wire', function (wire) {
    wire.use(wt_ilp({
      account: _this.walletClient.account,
      price: _this.price,
      publicKey: _this.publicKey
    }))
    wire.wt_ilp.on('ilp_handshake', function (handshake) {
      debug('Got extended handshake', handshake)
      // wire.wt_ilp.unchoke()
      if (!_this.peerWires[handshake.publicKey]) {
        _this.peerWires[handshake.publicKey] = []
      }
      _this.peerWires[handshake.publicKey].push(wire)
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

WebTorrentIlp.prototype._chargePeerForRequest = function (wire, torrent, bytesRequested) {
  const peerPublicKey = wire.wt_ilp.peerPublicKey
  const peerBalance = this.peerBalances[peerPublicKey]

  // TODO get smarter about how we price the amount (maybe based on torrent rarity?)
  const amountToCharge = this.price.times(bytesRequested)

  if (peerBalance && peerBalance.greaterThan(amountToCharge)) {
    const newBalance = peerBalance.minus(amountToCharge)
    this.peerBalances[wire.wt_ilp.peerPublicKey] = newBalance
    debug('charging peer ' + peerPublicKey + ' ' + amountToCharge.toString() + ' for request. balance now: ' + newBalance)
    torrent.totalEarned = torrent.totalEarned.plus(amountToCharge)
    wire.wt_ilp.unchoke()
  } else {
    wire.wt_ilp.sendLowBalance(0)
    wire.wt_ilp.forceChoke()
  }
}

WebTorrentIlp.prototype._payPeer = function (wire, torrent) {
  const _this = this
  const peerPublicKey = wire.wt_ilp.peerPublicKey
  const peerAccount = wire.wt_ilp.peerAccount

  const sourceAmount = this._calculateAmountToPay(wire, torrent)

  if (sourceAmount.greaterThan(0)) {
    // TODO make one function to track payments to peers and one to subtract it when necessary @tomorrow
    // Track how much we've sent to them
    this.peersTotalSent[peerPublicKey] = this.peersTotalSent[peerPublicKey].plus(sourceAmount)

    // Track how much we've sent them for this torrent
    torrent.spentPerPeer[peerPublicKey] = torrent.spentPerPeer[peerPublicKey].plus(sourceAmount)

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
  }
}

WebTorrentIlp.prototype._calculateAmountToPay = function (wire, torrent) {
  const peerPublicKey = wire.wt_ilp.peerPublicKey
  // TODO make sure we're checking they're actually sending us pieces we want
  if (!this.peersTotalSent[peerPublicKey]) {
    this.peersTotalSent[peerPublicKey] = new BigNumber(0)
  }
  if (!torrent.spentPerPeer[peerPublicKey]) {
    torrent.spentPerPeer[peerPublicKey] = new BigNumber(0)
  }

  // If we've paid them and they haven't sent us anything, don't pay any more
  const amountSpentOnPeer = torrent.spentPerPeer[peerPublicKey]
  if (wire.downloaded === 0 && amountSpentOnPeer.greaterThan(0)) {
    debug('not sending any more money until we get more data from the seeder')
    return new BigNumber(0)
  }

  // To calculate the amount we're willing to spend, take into account:
  // - how many peers are seeding the file
  // - how far done it is
  // - how high priority it is
  // - whether this peer is faster than the average

  // Peer stats
  // TODO make sure we're tracking peer stats across multiple wires
  const peerDownloadSpeed = wire.downloadSpeed()
  const peerCostPerByte = amountSpentOnPeer.div(wire.downloaded)

  const torrentAverageDownloadSpeed = torrent.downloadSpeed
  const torrentPeers = torrent.numPeers
  const torrentProgress = torrent.progress

  // TODO make maxCostPerByte calculation more intelligent (based on how many other peers there are, their prices, etc)
  const maxCostPerByte = this.price.times(2)

  debug('calculating amount to pay peer:')
  debug('bytes downloaded: ' + wire.downloaded)
  debug('download speed: ' + peerDownloadSpeed)
  debug('amount spent: ' + amountSpentOnPeer)
  debug('peer costPerByte: ' + peerCostPerByte)
  debug('torrentAverageDownloadSpeed: ' + torrentAverageDownloadSpeed)
  debug('torrentPeers: ' + torrentPeers)
  debug('torrentProgress: ' + torrentProgress)
  debug('torrent length: ' + torrent.length)

  const torrentBytesRemaining = new BigNumber(torrent.length - torrent.downloaded)
  const avgBytesPerPeerRemaining = torrentBytesRemaining.div(torrentPeers)

  // if (costPerByte.greaterThan(maxCostPerByte)) {
  //   debug('not sending any more money because the cost per byte is too high: ' + costPerByte.toString())
  //   return new BigNumber(0)
  // }

  return this.price.times(avgBytesPerPeerRemaining)
}

WebTorrentIlp.prototype._handleIncomingPayment = function (credit) {
  if (credit.memo && typeof credit.memo === 'object') {
    const peerPublicKey = credit.memo.public_key
    if (!peerPublicKey) {
      return
    }
    const previousBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)
    const newBalance = previousBalance.plus(credit.amount)
    debug('crediting peer: ' + peerPublicKey + ' for payment of: ' + credit.amount + '. balance now: ' + newBalance)
    this.peerBalances[peerPublicKey] = newBalance
    // Unchoke all of this peer's wires
    for (let wire of this.peerWires[peerPublicKey]) {
      wire.unchoke()
    }
  }
}

WebTorrentIlp.prototype._handleOutgoingPayment = function (debit) {
  // debug('xxx got outgoing debit %o', debit)
}

module.exports = WebTorrentIlp
for (let key in WebTorrent) {
  module.exports[key] = WebTorrent[key]
}
