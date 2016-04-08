'use strict'

import wt_ilp from 'wt_ilp'
import moment from 'moment'
import BigNumber from 'bignumber.js'
import WalletClient from './walletClient'
import Debug from 'debug'
const debug = Debug('WebTorrentIlp')
import Decider from './decider'
import uuid from 'uuid'
import paymentLicense from 'payment-license'
import WebTorrent from 'webtorrent'

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
    this.walletClient.on('outgoing_executed', this._handleOutgoingPayment.bind(this))
    this.walletClient.on('ready', () => this.emit('wallet_ready'))

    // <peerPublicKey>: <balance>
    this.peerBalances = {}
    // <peerPublicKey>: <[wire, wire]>
    this.peerWires = {}
  }

  seed () {
    const torrent = WebTorrent.prototype.seed.apply(this, arguments)
    this._setupWtIlp(torrent)
    return torrent
  }

  add () {
    return this.download.apply(this, arguments)
  }

  download () {
    const torrent = WebTorrent.prototype.download.apply(this, arguments)
    this._setupWtIlp(torrent)
    return torrent
  }

  _payForLicense (torrent) {
    // If we already have a valid license, no need to pay for it again
    if (paymentLicense.isValidLicense(torrent.license)) {
      return
    }

    // TODO make license time configurable
    const DEFAULT_LICENSE_TIME = 60 * 24 // in minutes
    torrent.license.expires_at = moment().add(DEFAULT_LICENSE_TIME, 'minutes').toISOString()

    // TODO catch errors
    // TODO check for license type
    const payment = {
      destinationAccount: torrent.license.creator_account,
      destinationAmount: (new BigNumber(DEFAULT_LICENSE_TIME)).times(torrent.license.price_per_minute),
      destinationMemo: {
        expires_at: torrent.license.expires_at,
        licensee_public_key: this.publicKey
      },
      sourceMemo: {
        content_hash: torrent.infoHash
      }
    }
    debug('About to pay for license %o', payment)
    this.walletClient.sendPayment(payment)
  }

  // Note this is called in both _makeTorrentWaitForWalletAndLicense and _handleOutgoingPayment
  _checkIfTorrentIsReady (torrent) {
    if (this.walletClient.ready && paymentLicense.isValidLicense(torrent.license)) {
      torrent.resume()
    } else {
      torrent.pause()
    }
  }

  // TODO separate out paying for the license because we may only
  // want to pay for a license once we connect to a peer or one connects to us
  _makeTorrentWaitForWalletAndLicense (torrent) {
    const _this = this
    torrent.on('listening', () => {
      // Start out paused and only resume when the wallet client is ready
      // and we have a valid license for this file
      // torrent.pause()

      // TODO should we add the license to the torrent object here
      // or just in a modified version of parse-torrent-file?
      // The only reason not to use a modified parse-torrent-file module is the annoyance
      // of having another forked repo for that one and parse-torrent
      torrent.license = {}
      for (let key of Object.keys(torrent.info.license)) {
        torrent.license[key] = torrent.info.license[key].toString()
      }

      if (!torrent.license) {
        torrent.destroy()
        _this.emit('error', new Error('Cannot seed or download torrent without license information'))
        return
      }

      _this._payForLicense(torrent)

      if (!_this.walletClient.ready) {
        _this.walletClient.once('ready', () => _this._checkIfTorrentIsReady(torrent))
      }
    })
  }

  _onWire (torrent, wire) {
    wire.bidAmount = this.price.times(this.startingBid)
    debug('starting bid amount: ' + wire.bidAmount.toString())

    // TODO @tomorrow add license to handshake or add an extra wt_ilp message for exchanging it
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
    if (torrent.__setupWithIlp) {
      return torrent
    }

    this._makeTorrentWaitForWalletAndLicense(torrent)

    torrent.on('wire', this._onWire.bind(this, torrent))

    torrent.on('done', () => {
      debug('torrent total cost: ' + this.decider.getTotalSent({
        torrentHash: torrent.infoHash
      }))
    })

    torrent.on('error', (err) => {
      debug('torrent error:', err)
    })

    torrent.__setupWithIlp = true
  }

  _chargePeerForRequest (wire, torrent, bytesRequested) {
    const peerPublicKey = wire.wt_ilp.peerPublicKey
    const peerBalance = this.peerBalances[peerPublicKey] || new BigNumber(0)

    // TODO get smarter about how we price the amount (maybe based on torrent rarity?)
    const amountToCharge = this.price.times(bytesRequested / 1000)
    debug('peer request costs: ' + amountToCharge.toString())

    if (peerBalance.greaterThan(amountToCharge)) {
      const newBalance = peerBalance.minus(amountToCharge)
      this.peerBalances[wire.wt_ilp.peerPublicKey] = newBalance
      debug('charging ' + amountToCharge.toString() + ' for request. balance now: ' + newBalance + ' (' + peerPublicKey.slice(0, 8) + ')')
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
    debug('pay peer ' + destinationAccount + ' ' + destinationAmount)
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
      return {
        decision: _this.decider.shouldSendPayment(paymentRequest),
        paymentRequest
      }
    })
    // Send payment
    .then(({ decision, paymentRequest }) => {
      if (decision === true) {
        const paymentId = uuid.v4()
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
      debug('Crediting peer for payment of: ' + credit.amount + '. balance now: ' + newBalance + ' (' + peerPublicKey.slice(0, 8) + ')')
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

  _handleOutgoingPayment (debit, fulfillment) {
    if (debit.memo && typeof debit.memo === 'object' && debit.memo.content_hash) {
      for (let torrent of this.torrents) {
        if (torrent.infoHash === debit.memo.content_hash) {
          const signature = (typeof fulfillment === 'object' ? fulfillment.signature : fulfillment)
          if (torrent.license.signature === signature) {
            return
          }
          torrent.license.signature = signature
          debug('Got license for torrent: %s , license signature: %s', torrent.infoHash, torrent.license.signature)
          this.emit('license', torrent.infoHash, torrent.license)
          // The torrent might be waiting for the license to come back so we
          // check here if we should start it up now
          this._checkIfTorrentIsReady(torrent)
        }
      }
    }
  }
}

// Note that using module.exports instead of export const here is a hack
// to make this work with https://github.com/59naga/babel-plugin-add-module-exports
module.exports.WEBRTC_SUPPORT = WebTorrent.WEBRTC_SUPPORT
