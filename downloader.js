'use strict'

const WebTorrentIlp = require('./build/index')
const debug = require('debug')('WebTorrentIlp:downloader')
const crypto = require('crypto')

const leecher = new WebTorrentIlp({
  address: process.env.ADDRESS || 'alice@blue.ilpdemo.org',
  password: process.env.PASSWORD || 'alice',
  publicKey: crypto.randomBytes(32).toString('base64'),
  price: process.env.PRICE || '0.00000000001'
})

const magnetURI = process.argv.length > 2 ? process.argv[2] : 'magnet:?xt=urn:btih:eca3080363229696b44f99f12e1cab902965777d&dn=interledger.pdf&tr=http%3A%2F%2Flocalhost%3A8000%2Fannounce'

const leecherTorrent = leecher.add(magnetURI, {
  announceList: [['http://localhost:8000/announce']]
})
leecherTorrent.on('done', function () {
  debug('leecher done, downloaded ' + leecherTorrent.files.length + ' files')
})
leecherTorrent.on('wire', function (wire) {
  debug('on wire')
})