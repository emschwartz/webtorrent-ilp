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
  this.walletClient.on('ready', function () {
    _this.emit('wallet_ready')
  })

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
  // Keep track of how much we've downloaded from each peer across different wire instances
  torrent.bytesDownloadedFromPeer = {}

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

    wire.on('download', function (bytes) {
      // TODO @tomorrow make sure we're properly crediting peers for how many bytes they send to us
      const peerPublicKey = wire.wt_ilp.peerPublicKey
      if (peerPublicKey) {
        if (!torrent.bytesDownloadedFromPeer[peerPublicKey]) {
          torrent.bytesDownloadedFromPeer[peerPublicKey] = new BigNumber(0)
        }
        torrent.bytesDownloadedFromPeer[peerPublicKey] = torrent.bytesDownloadedFromPeer[peerPublicKey].plus(bytes)
      }
    })

    wire.wt_ilp.on('warning', function (err) {
      debug('Error', err)
    })

    wire.wt_ilp.forceChoke()
  })

  torrent.on('done', function () {
    debug('torrent total cost: ' + torrent.totalCost.toString())
  })
}

WebTorrentIlp.prototype._chargePeerForRequest = function (wire, torrent, bytesRequested) {
  const peerPublicKey = wire.wt_ilp.peerPublicKey
  const peerBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)

  // TODO get smarter about how we price the amount (maybe based on torrent rarity?)
  const amountToCharge = this.price.times(bytesRequested)

  // TODO send low balance notice when the balance is low, not just when it's too low to make another request
  if (peerBalance.greaterThan(amountToCharge)) {
    const newBalance = peerBalance.minus(amountToCharge)
    this.peerBalances[wire.wt_ilp.peerPublicKey] = newBalance
    debug('charging ' + amountToCharge.toString() + ' for request. balance now: ' + newBalance + ' (' + peerPublicKey.slice(0,8) + ')')
    torrent.totalEarned = torrent.totalEarned.plus(amountToCharge)
    wire.wt_ilp.unchoke()
  } else {
    debug('low balance: ' + peerBalance + '(' + peerPublicKey.slice(0,8) + ')')
    wire.wt_ilp.sendLowBalance(peerBalance.toString())
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
    this.emit('outgoing_payment', {
      peerPublicKey: peerPublicKey,
      amount: sourceAmount.toString()
    })
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
  if (!torrent.bytesDownloadedFromPeer[peerPublicKey]) {
    torrent.bytesDownloadedFromPeer[peerPublicKey] = new BigNumber(0)
  }

  // Peer stats
  const amountSpentOnPeer = torrent.spentPerPeer[peerPublicKey]
  const bytesDownloadedFromPeer = torrent.bytesDownloadedFromPeer[peerPublicKey]
  const peerDownloadSpeed = wire.downloadSpeed()
  const peerCostPerByte = bytesDownloadedFromPeer ? amountSpentOnPeer.div(bytesDownloadedFromPeer) : null

  // Torrent stats
  const torrentAverageDownloadSpeed = torrent.downloadSpeed
  const torrentPeers = torrent.numPeers
  const torrentProgress = torrent.progress
  const torrentBytesRemaining = new BigNumber(torrent.length - torrent.downloaded)

  // If we've paid them and they haven't sent us anything, don't pay any more
  if (bytesDownloadedFromPeer === 0 && amountSpentOnPeer.greaterThan(0)) {
    debug('not sending any more money until we get more data from the seeder (' + peerPublicKey.slice(0,8) + ')')
    return new BigNumber(0)
  }

  // Calculate how much to pay this peer
  const bytesToPayAveragePeerFor = BigNumber.min(
    torrentBytesRemaining.div(torrentPeers),
    100000)
  // We trust this peer to send us at least some fraction of what they've already sent us
  // TODO take into account how much we've ever downloaded from this peer (not just from this torrent)
  const bytesToTrustPeerFor = BigNumber.min(
    bytesDownloadedFromPeer.times(0.75),
    torrentBytesRemaining)
  const bytesToPayPeerFor = BigNumber.max(
    bytesToPayAveragePeerFor,
    bytesToTrustPeerFor)
  // TODO get precision and scale from the ledger
  const minLedgerAmount = 0.0002
  // TODO make sure we don't overpay for a torrent when downloading from multiple peers
  const amountToPayPeer = BigNumber.max(
    this.price.times(bytesToPayPeerFor),
    minLedgerAmount)

  // TODO take into account the peer price and download speed when determining how much to send them

  debug('calculating amount to pay peer:')
  debug('bytes downloaded: ' + bytesDownloadedFromPeer)
  debug('download speed: ' + peerDownloadSpeed)
  debug('amount spent: ' + amountSpentOnPeer)
  debug('peer costPerByte: ' + peerCostPerByte)
  debug('torrentAverageDownloadSpeed: ' + torrentAverageDownloadSpeed)
  debug('torrentPeers: ' + torrentPeers)
  debug('torrentProgress: ' + torrentProgress)
  debug('torrent length: ' + torrent.length)
  debug('torrentBytesRemaining: ' + torrentBytesRemaining)
  debug('bytesToPayPeerFor: ' + bytesToPayPeerFor)
  debug('amountToPayPeer: ' + amountToPayPeer)

  return amountToPayPeer
}

WebTorrentIlp.prototype._handleIncomingPayment = function (credit) {
  if (credit.memo && typeof credit.memo === 'object') {
    const peerPublicKey = credit.memo.public_key
    if (!peerPublicKey) {
      return
    }
    const previousBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)
    const newBalance = previousBalance.plus(credit.amount)
    debug('crediting peer for payment of: ' + credit.amount + '. balance now: ' + newBalance + ' (' + peerPublicKey.slice(0,8) + ')')
    this.peerBalances[peerPublicKey] = newBalance
    this.emit('incoming_payment', {
      peerPublicKey: peerPublicKey,
      amount: credit.amount
    })
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
