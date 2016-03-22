'use strict'

const WebTorrentIlp = require('./index')

const leecher = new WebTorrentIlp({
  walletAddress: 'alice@blue.ilpdemo.org',
  walletPassword: 'alice',
  publicKey: 'lfFMEl9mWw56HygZGYejElw64wnKschRQSzu+JuZkVw=',
  price: '0.0001'
})

const magnetURI = 'magnet:?xt=urn:btih:a3734717a96baaf7ab9afad20ac47371066acc6a&dn=570994.PNG&tr=http%3A%2F%2Flocalhost%3A8000%2Fannounce'

const leecherTorrent = leecher.add(magnetURI, {
  announceList: [['http://localhost:8000/announce']]
})
leecherTorrent.on('download', function (chunkSize) {
  console.log('leecher downloaded ' + chunkSize)
})
leecherTorrent.on('done', function () {
  console.log('leecher done, downloaded ' + leecherTorrent.files.length + ' files')
})