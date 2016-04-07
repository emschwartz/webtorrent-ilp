'use strict'

const WebTorrentIlp = require('./build/index')
const debug = require('debug')('WebTorrentIlp:seeder')
const crypto = require('crypto')

const seeder = new WebTorrentIlp({
  address: process.env.ADDRESS || 'walt@red.ilpdemo.org',
  password: process.env.PASSWORD || 'walt',
  publicKey: crypto.randomBytes(32).toString('base64'),
  price: process.env.PRICE || '0.00000000001'
})

const file = process.argv.length > 2 ? process.argv[2] : '/Users/eschwartz/Downloads/interledger.pdf'

const seederTorrent = seeder.seed(file, {
  announceList: [['http://localhost:8000/announce']],
  private: true
})

seeder.on('torrent', function (torrent) {
  console.log('seeding torrent ' + torrent.infoHash + ' ' + torrent.magnetURI)
})
