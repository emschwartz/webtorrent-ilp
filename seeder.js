'use strict'

const WebTorrentIlp = require('./index')

const seeder = new WebTorrentIlp({
  walletUri: 'https://red.ilpdemo.org',
  username: 'walt',
  password: 'walt',
  price: '0.0001',
    // TODO license should come from the torrent file
  license: {
    content_hash: 'a3734717a96baaf7ab9afad20ac47371066acc6a',
    creator_account: "https://red.ilpdemo.org/ledger/accounts/walt",
    creator_public_key: "QwRCBaiU95sIYi19/A4PqSpz93lQpchheiS1BVtlnVM=",
    license: "https://creativecommons.org/licenses/pay/1.0",
    licensee_public_key: '7cLvHbeOmx4TGZovRInmw37xSGHm6P96VM+Ng5z0+C8=',
    expires_at: '2016-06-01T12:00:00Z',
    signature: 'thanks!'
  }
})

const seederTorrent = seeder.seed('/Users/eschwartz/Downloads/570994.PNG', {
  announceList: [['http://localhost:8000/announce']]
})

seeder.on('torrent', function (torrent) {
  console.log('seeding torrent ' + torrent.infoHash + ' ' + torrent.magnetURI)
})
