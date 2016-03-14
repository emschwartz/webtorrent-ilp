'use strict'

const WebTorrent = require('webtorrent')
const inherits = require('inherits')
const wt_ilp = require('wt_ilp')
const PaymentManager = require('./src/paymentManager').PaymentManager

function WebTorrentIlp (opts) {
  const _this = this

  // if (!opts.walletAddress) {
  //   throw new Error('Must provide walletAddress')
  // }
  // if (!opts.walletPassword) {
  //   throw new Error('Must provide walletPassword')
  // }

  WebTorrent.call(this, opts)

  this.paymentManager = new PaymentManager({
    walletUri: opts.walletUri,
    username: opts.username,
    password: opts.password
    // walletAddress: opts.walletAddress,
    // walletPassword: opts.walletPassword,
    // publicKey: opts.publicKey
  })
  this.paymentManager.connect()

  this.on('torrent', function (torrent) {

    torrent.on('wire', function (wire) {
      wire.use(wt_ilp({
        paymentManager: _this.paymentManager,
        // TODO handle getting the signed license
        license: opts.license,
        price: opts.price
      }))
    })
  })
}

inherits(WebTorrentIlp, WebTorrent)

module.exports = WebTorrentIlp
for (let key in WebTorrent) {
  module.exports[key] = WebTorrent[key]
}
