'use strict'

const WebTorrent = require('webtorrent')
const inherits = require('inherits')
const wt_ilp = require('wt_ilp')
const PaymentManager = require('./src/paymentManager').PaymentManager
const moment = require('moment')
const debug = require('debug')('WebTorrentIlp')

inherits(WebTorrentIlp, WebTorrent)

function WebTorrentIlp (opts) {
  const _this = this

  if (!opts.walletAddress) {
    throw new Error('Must provide walletAddress')
  }
  if (!opts.walletPassword) {
    throw new Error('Must provide walletPassword')
  }

  WebTorrent.call(this, opts)

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
  torrent.on('wire', function (wire) {
    wire.use(wt_ilp({
      account: 'opts.walletAddress',
      price: '1',
      publicKey: 'opts.publicKey'
    }))
    wire.wt_ilp.on('request', function () {
      debug('wt_ilp got request')
    })
    wire.wt_ilp.on('ilp_handshake', function (details) {
      debug('Got extended handshake', details)
      wire.wt_ilp.unchoke()
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
