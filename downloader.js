'use strict'

const WebTorrentIlp = require('./index')
const debug = require('debug')('WebTorrentIlp:downloader')

const leecher = new WebTorrentIlp({
  walletAddress: 'alice@blue.ilpdemo.org',
  walletPassword: 'alice',
  publicKey: 'lfFMEl9mWw56HygZGYejElw64wnKschRQSzu+JuZkVw=',
  price: '0.0001'
})

const magnetURI = 'magnet:?xt=urn:btih:eca3080363229696b44f99f12e1cab902965777d&dn=interledger.pdf&tr=http%3A%2F%2Flocalhost%3A8000%2Fannounce'

const leecherTorrent = leecher.add(magnetURI, {
  announceList: [['http://localhost:8000/announce']]
})
leecherTorrent.on('download', function (chunkSize) {
  debug('leecher downloaded ' + chunkSize)
})
leecherTorrent.on('done', function () {
  debug('leecher done, downloaded ' + leecherTorrent.files.length + ' files')
})
leecherTorrent.on('wire', function (wire) {
  debug('on wire')
})