'use strict'

import WebTorrent from 'webtorrent'
import wt_ilp from 'wt_ilp'
import moment from 'moment'
import BigNumber from 'bignumber.js'
import WalletClient from './walletClient'
import Debug from 'debug'
const debug = Debug('WebTorrentIlp')
import Decider from './decider'
import uuid from 'uuid'

export default class WebTorrentIlp extends WebTorrent {
  constructor (opts) {
    super(opts)

    this.address = opts.address
    this.password = opts.password
    this.price = new BigNumber(opts.price) // price per kb
    debug('set price per kb: ' + this.price.toString())
    this.publicKey = opts.publicKey

    this.startingBid = opts.startingBid || this.price.times(100)
    this.bidDecreaseFactor = opts.bidDecreaseFactor || 0.95
    this.bidIncreaseFactor = opts.bidIncreaseFactor || 1.5

    this.decider = new Decider()

    this.walletClient = new WalletClient({
      address: opts.address,
      password: opts.password
    })
    this.walletClient.connect()
    this.walletClient.on('incoming', this._handleIncomingPayment.bind(this))
    this.walletClient.on('outgoing', this._handleOutgoingPayment.bind(this))
    this.walletClient.on('ready', () => this.emit('wallet_ready'))

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

  _catchTorrent (fnName, functionsToCall) {
    const _this = this
    const oldFn = this[fnName]
    this[fnName] = function () {
      const torrent = oldFn.apply(_this, arguments)
      // Make sure we don't set up the torrent twice
      if (!torrent.__setupWithIlp) {
        for (let fn of functionsToCall) {
          fn(torrent)
        }
        torrent.__setupWithIlp = true
      }
      return torrent
    }
  }

  _waitForWalletClient (torrent) {
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
        _this.walletClient.once('ready', () => {
          _onParsedTorrent.apply(torrent, args)
        })
      }
    }
  }

  _onWire (torrent, wire) {
    wire.bidAmount = this.price.times(this.startingBid)
    debug('starting bid amount: ' + wire.bidAmount.toString())

    wire.use(wt_ilp({
      account: this.walletClient.account,
      price: this.price,
      publicKey: this.publicKey
    }))
    wire.wt_ilp.on('ilp_handshake', (handshake) => {
      debug('Got extended handshake', handshake)
      // wire.wt_ilp.unchoke()
      if (!this.peerWires[handshake.publicKey]) {
        this.peerWires[handshake.publicKey] = []
      }
      this.peerWires[handshake.publicKey].push(wire)
    })

    // Charge peers for requesting data from us
    wire.wt_ilp.on('request', this._chargePeerForRequest.bind(this, wire, torrent))
    wire.wt_ilp.on('payment_request_too_high', (amount) => {
      debug('Got payment_request_too_high' + (amount ? ' ' + amount : ''))
      wire.bidAmount = wire.bidAmount.times(this.bidDecreaseFactor)
    })

    // Pay peers who we are downloading from
    wire.wt_ilp.on('payment_request', this._payPeer.bind(this, wire, torrent))

    wire.on('download', (bytes) => {
      debug('downloaded ' + bytes + ' bytes (' + wire.wt_ilp.peerPublicKey.slice(0, 8) + ')')
      this.decider.recordDelivery({
        publicKey: wire.wt_ilp.peerPublicKey,
        torrentHash: torrent.infoHash,
        bytes: bytes,
        timestamp: moment().toISOString()
      })
    })

    wire.wt_ilp.on('warning', (err) => {
      debug('Error', err)
    })

    wire.wt_ilp.forceChoke()
  }

  _setupWtIlp (torrent) {
    torrent.totalEarned = new BigNumber(0)

    torrent.on('wire', this._onWire.bind(this, torrent))

    torrent.on('done', () => {
      debug('torrent total cost: ' + this.decider.getTotalSent({
        torrentHash: torrent.infoHash
      }))
    })

    torrent.on('error', (err) => {
      debug('torrent error:', err)
    })
  }

  _chargePeerForRequest (wire, torrent, bytesRequested) {
    const peerPublicKey = wire.wt_ilp.peerPublicKey
    const peerBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)

    // TODO get smarter about how we price the amount (maybe based on torrent rarity?)
    const amountToCharge = this.price.times(bytesRequested / 1000)

    if (peerBalance.greaterThan(amountToCharge)) {
      const newBalance = peerBalance.minus(amountToCharge)
      this.peerBalances[wire.wt_ilp.peerPublicKey] = newBalance
      debug('charging ' + amountToCharge.toString() + ' for request. balance now: ' + newBalance + ' (' + peerPublicKey.slice(0, 8) + ')')
      torrent.totalEarned = torrent.totalEarned.plus(amountToCharge)
      wire.wt_ilp.unchoke()
    } else {
      // TODO @tomorrow add bidding agent to track how much peer is willing to send at a time

      // If the amount we request up front is too low, the peer will send us money
      // then we won't do anything because it'll be less than the amountToCharge
      // and then they'll never send us anything again
      if (!wire.bidAmount || amountToCharge.greaterThan(wire.bidAmount)) {
        wire.bidAmount = amountToCharge
      }

      // TODO handle the min ledger amount more elegantly
      const MIN_LEDGER_AMOUNT = '0.0001'
      wire.wt_ilp.sendPaymentRequest(BigNumber.max(wire.bidAmount, MIN_LEDGER_AMOUNT))
      wire.wt_ilp.forceChoke()
    }
  }

  _payPeer (wire, torrent, destinationAmount) {
    const _this = this
    const destinationAccount = wire.wt_ilp.peerAccount
    // Convert the destinationAmount into the sourceAmount
    return this.walletClient.normalizeAmount({
      destinationAccount,
      destinationAmount
    })
    // Decide if we should pay
    .then((sourceAmount) => {
      const paymentRequest = {
        sourceAmount,
        destinationAccount,
        publicKey: wire.wt_ilp.peerPublicKey,
        torrentHash: torrent.infoHash,
        torrentBytesRemaining: torrent.length - torrent.downloaded,
        timestamp: moment().toISOString()
      }
      return _this.decider.shouldSendPayment(paymentRequest)
        .then((decision) => {
          return { decision, paymentRequest }
        })
    })
    // Send payment
    .then(({ decision, paymentRequest }) => {
      if (decision === true) {
        const paymentId = uuid.v4()
        // TODO we should probably wait until this promise resolves
        _this.decider.recordPayment({
          ...paymentRequest,
          paymentId
        })
        const paymentParams = {
          sourceAmount: paymentRequest.sourceAmount,
          destinationAccount: paymentRequest.destinationAccount,
          destinationMemo: {
            public_key: _this.publicKey
          },
          sourceMemo: {
            public_key: paymentRequest.publicKey
          }
        }
        debug('About to send payment: %o', paymentParams)
        _this.emit('outgoing_payment', {
          peerPublicKey: paymentRequest.publicKey,
          amount: paymentRequest.sourceAmount.toString()
        })
        _this.walletClient.sendPayment(paymentParams)
          .then((result) => debug('Sent payment %o', result))
          .catch((err) => {
            // If there was an error, subtract the amount from what we've paid them
            // TODO make sure we actually didn't pay them anything
            debug('Error sending payment %o', err)
            _this.decider.recordFailedPayment(paymentId, err)
          })
      } else {
        debug('Decider told us not to fulfill request %o', paymentRequest)
        wire.wt_ilp.sendPaymentRequestTooHigh()
      }
    })
  }

  _handleIncomingPayment (credit) {
    if (credit.memo && typeof credit.memo === 'object') {
      const peerPublicKey = credit.memo.public_key
      if (!peerPublicKey) {
        return
      }
      const previousBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)
      const newBalance = previousBalance.plus(credit.amount)
      debug('crediting peer for payment of: ' + credit.amount + '. balance now: ' + newBalance + ' (' + peerPublicKey.slice(0, 8) + ')')
      this.peerBalances[peerPublicKey] = newBalance
      this.emit('incoming_payment', {
        peerPublicKey: peerPublicKey,
        amount: credit.amount
      })
      // Unchoke all of this peer's wires
      for (let wire of this.peerWires[peerPublicKey]) {
        wire.unchoke()
        wire.bidAmount = wire.bidAmount.times(this.bidIncreaseFactor)
      }
    }
  }

  _handleOutgoingPayment (debit) {
    // debug('xxx got outgoing debit %o', debit)
  }
}

// Note that using module.exports instead of export const here is a hack
// to make this work with https://github.com/59naga/babel-plugin-add-module-exports
module.exports.WEBRTC_SUPPORT = WebTorrent.WEBRTC_SUPPORT