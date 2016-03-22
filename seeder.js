'use strict'

const WebTorrentIlp = require('./index')

const seeder = new WebTorrentIlp({
  walletAddress: 'walt@red.ilpdemo.org',
  walletPassword: 'walt',
  publicKey: '7cLvHbeOmx4TGZovRInmw37xSGHm6P96VM+Ng5z0+C8=',
  price: '0.0001'
})

const seederTorrent = seeder.seed('/Users/eschwartz/Downloads/570994.PNG', {
  announceList: [['http://localhost:8000/announce']]
})

seeder.on('torrent', function (torrent) {
  console.log('seeding torrent ' + torrent.infoHash + ' ' + torrent.magnetURI)
})
