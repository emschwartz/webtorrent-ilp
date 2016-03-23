'use strict'

const WebTorrent = require('webtorrent')
const inherits = require('inherits')
const wt_ilp = require('wt_ilp')
const moment = require('moment')
const debug = require('debug')('WebTorrentIlp')
const BigNumber = require('bignumber.js')
const sendPayment = require('five-bells-sender')

inherits(WebTorrentIlp, WebTorrent)

function WebTorrentIlp (opts) {
  const _this = this

  WebTorrent.call(this, opts)

  this.account = opts.account
  this.password = opts.password
  this.price = new BigNumber(opts.price)
  this.publicKey = opts.publicKey

  this._catchTorrent('add', this._setupWtIlp.bind(_this))
  this._catchTorrent('download', this._setupWtIlp.bind(_this))
  this._catchTorrent('seed', this._setupWtIlp.bind(_this))
}

WebTorrentIlp.prototype._catchTorrent = function (fnName, fnToCall) {
  const _this = this
  const oldFn = this[fnName]
  this[fnName] = function () {
    const torrent = oldFn.apply(_this, arguments)
    fnToCall(torrent)
    return torrent
  }
}

WebTorrentIlp.prototype._setupWtIlp = function (torrent) {
  const _this = this
  torrent.on('wire', function (wire) {
    wire.use(wt_ilp({
      account: _this.account,
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
      const paymentParams = {
        sourceAccount: _this.account,
        sourcePassword: _this.password,
        sourceAmount: _this.price.times(10).toString(),
        destinationAccount: wire.wt_ilp.peerAccount,
        destinationMemo: {
          public_key: _this.publicKey
        }
      }
      debug('About to send payment: %o', paymentParams)
      sendPayment(paymentParams)
      .then(function (result) {
        debug('Sent payment', result)
      })
      .catch(function (err) {
        debug('Error sending payment', err)
      })
    })
    wire.wt_ilp.on('warning', function (err) {
      debug('Error', err)
    })

    wire.wt_ilp.forceChoke()
  })
}

module.exports = WebTorrentIlp
for (let key in WebTorrent) {
  module.exports[key] = WebTorrent[key]
}
