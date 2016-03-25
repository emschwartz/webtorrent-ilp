'use strict'

const WebTorrentIlp = require('./index')
const debug = require('debug')('WebTorrentIlp:seeder')

const seeder = new WebTorrentIlp({
  address: 'walt@red.ilpdemo.org',
  password: 'walt',
  publicKey: '7cLvHbeOmx4TGZovRInmw37xSGHm6P96VM+Ng5z0+C8=',
  price: '0.00000001'
})

const seederTorrent = seeder.seed('/Users/eschwartz/Downloads/interledger.pdf', {
  announceList: [['http://localhost:8000/announce']],
  private: true
})

seeder.on('torrent', function (torrent) {
  console.log('seeding torrent ' + torrent.infoHash + ' ' + torrent.magnetURI)
})
