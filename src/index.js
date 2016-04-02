'use strict'

import WebTorrent from 'webtorrent'
import wt_ilp from 'wt_ilp'
import moment from 'moment'
import BigNumber from 'bignumber.js'
import WalletClient from './walletClient'
import Debug from 'debug'
const debug = Debug('WebTorrentIlp')
import Decider from './decider'

export default class WebTorrentIlp extends WebTorrent {
  constructor (opts) {
    super(opts)

    this.address = opts.address
    this.password = opts.password
    this.price = new BigNumber(opts.price) // price per byte
    this.publicKey = opts.publicKey

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
      for (let fn of functionsToCall) {
        fn(torrent)
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

  _setupWtIlp (torrent) {
    torrent.totalEarned = new BigNumber(0)

    torrent.on('wire', (wire) => {
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

      // Pay peers who we are downloading from
      wire.wt_ilp.on('payment_request', this._payPeer.bind(this, wire, torrent))

      wire.on('download', (bytes) => {
        this.decider.recordDelivery({
          publicKey: wire.wt_ilp.peerPublicKey,
          torrentHash: torrent.infoHash,
          bytes: bytes
        })
      })

      wire.wt_ilp.on('warning', (err) => {
        debug('Error', err)
      })

      wire.wt_ilp.forceChoke()
    })

    torrent.on('done', () => {
      this.decider.getTotalSent({
        torrentHash: torrent.infoHash
      }).then((amount) => {
        debug('torrent total cost: ' + amount)
      })
    })
  }

  _chargePeerForRequest (wire, torrent, bytesRequested) {
    const peerPublicKey = wire.wt_ilp.peerPublicKey
    const peerBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)

    // TODO get smarter about how we price the amount (maybe based on torrent rarity?)
    const amountToCharge = this.price.times(bytesRequested)

    // TODO send low balance notice when the balance is low, not just when it's too low to make another request
    if (peerBalance.greaterThan(amountToCharge)) {
      const newBalance = peerBalance.minus(amountToCharge)
      this.peerBalances[wire.wt_ilp.peerPublicKey] = newBalance
      debug('charging ' + amountToCharge.toString() + ' for request. balance now: ' + newBalance + ' (' + peerPublicKey.slice(0, 8) + ')')
      torrent.totalEarned = torrent.totalEarned.plus(amountToCharge)
      wire.wt_ilp.unchoke()
    } else {
      // TODO handle the min ledger amount more elegantly
      const MIN_LEDGER_AMOUNT = '0.0001'
      wire.wt_ilp.sendPaymentRequest(BigNumber.max(amountToCharge, MIN_LEDGER_AMOUNT))
      wire.wt_ilp.forceChoke()
    }
  }

  _payPeer (wire, torrent, requestedAmount) {
    // TODO @tomorrow Do pathfinding to normalize amount first
    const sourceAmount = requestedAmount // this.walletClient.getSourceAmount(requestedAmount)
    const paymentRequest = {
      sourceAmount: requestedAmount,
      publicKey: wire.wt_ilp.peerPublicKey,
      destinationAccount: wire.wt_ilp.peerAccount,
      torrentHash: torrent.infoHash,
      torrentBytesRemaining: torrent.length - torrent.downloaded,
      timestamp: moment().toISOString()
    }
    return this.decider.shouldSendPayment(paymentRequest)
      .then((decision) => {
        if (decision === true) {
          this.decider.recordPayment(paymentRequest)
          // TODO get id from recordPayment in case we need to cancel it because it failed
          const paymentParams = {
            sourceAmount: sourceAmount,
            destinationAccount: paymentRequest.destinationAccount,
            destinationMemo: {
              public_key: this.publicKey
            },
            sourceMemo: {
              public_key: paymentRequest.publicKey
            }
          }
          debug('About to send payment: %o', paymentParams)
          this.emit('outgoing_payment', {
            peerPublicKey: paymentRequest.publicKey,
            amount: sourceAmount.toString()
          })
          this.walletClient.sendPayment(paymentParams)
            .then((result) => debug('Sent payment %o', result))
            .catch((err) => {
              // If there was an error, subtract the amount from what we've paid them
              // TODO make sure we actually didn't pay them anything
              debug('Error sending payment %o', err)
              this.decider.recordFailedPayment(paymentParams, err)
            })
        } else {
          debug('Decider told us not to fulfill request %o', paymentRequest)
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
