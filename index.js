'use strict'

const WebTorrent = require('webtorrent')
const inherits = require('inherits')
const wt_ilp = require('wt_ilp')
const PaymentManager = require('./src/paymentManager').PaymentManager
const moment = require('moment')
const debug = require('debug')('WebTorrentIlp')

function WebTorrentIlp (opts) {
  const _this = this

  if (!opts.walletAddress) {
    throw new Error('Must provide walletAddress')
  }
  if (!opts.walletPassword) {
    throw new Error('Must provide walletPassword')
  }

  WebTorrent.call(this, opts)

  // this.paymentManager = new PaymentManager({
  //   walletAddress: opts.walletAddress,
  //   walletPassword: opts.walletPassword,
  //   price: '0.0001',
  //   publicKey: opts.publicKey
  // })
  // this.paymentManager.connect()

  this.on('torrent', function (torrent) {
    debug('on torrent')

    // // Convert license fields to strings
    // if (!torrent.license) {
    //   throw new Error('Cannot seed torrent without license details')
    // }
    // let license = {}
    // for (let key in torrent.license) {
    //   if (Buffer.isBuffer(torrent.license[key])) {
    //     license[key] = torrent.license[key].toString('utf8')
    //   }
    // }
    // torrent.license = license

    // // TODO check if we have paid for this license already
    // // If not, pay the creator and get the license
    // torrent.license.content_hash = torrent.infoHash
    // torrent.license.licensee_public_key = opts.publicKey
    // torrent.license.signature = 'sig'
    // torrent.license.expires_at = moment().add(1, 'days').toISOString()

    torrent.on('wire', function (wire) {
      debug('on wire')
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
  })
}

inherits(WebTorrentIlp, WebTorrent)

module.exports = WebTorrentIlp
for (let key in WebTorrent) {
  module.exports[key] = WebTorrent[key]
}
