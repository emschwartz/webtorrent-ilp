'use strict'

const WebTorrentIlp = require('./index')

const seeder = new WebTorrentIlp({
  walletAddress: 'walt@red.ilpdemo.org',
  walletPassword: 'walt',
  price: '0.0001',
  publicKey: '7cLvHbeOmx4TGZovRInmw37xSGHm6P96VM+Ng5z0+C8='
})

const seederTorrent = seeder.seed('/Users/eschwartz/Downloads/570994.PNG', {
  announceList: [['http://localhost:8000/announce']],
  license: {
    creator_account: "https://red.ilpdemo.org/ledger/accounts/walt",
    creator_public_key: "QwRCBaiU95sIYi19/A4PqSpz93lQpchheiS1BVtlnVM=",
    license: "https://creativecommons.org/licenses/pay/1.0",
    price_per_minute: "0.0001"
  }
})

seeder.on('torrent', function (torrent) {
  console.log('seeding torrent ' + torrent.infoHash + ' ' + torrent.magnetURI)
})
