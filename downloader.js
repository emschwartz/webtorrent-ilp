'use strict'

const WebTorrentIlp = require('./index')

const leecher = new WebTorrentIlp({
  walletAddress: 'alice@blue.ilpdemo.org',
  walletPassword: 'alice',
  publicKey: 'lfFMEl9mWw56HygZGYejElw64wnKschRQSzu+JuZkVw=',
  license: {
    content_hash: '482225dfebafe3941e8b89c5286b0c295459f4fd',
    creator_account: "https://red.ilpdemo.org/ledger/accounts/walt",
    creator_public_key: "QwRCBaiU95sIYi19/A4PqSpz93lQpchheiS1BVtlnVM=",
    license: "https://creativecommons.org/licenses/pay/1.0"
  }
})

const magnetURI = 'magnet:?xt=urn:btih:482225dfebafe3941e8b89c5286b0c295459f4fd&dn=570994.PNG&tr=http%3A%2F%2Flocalhost%3A8000%2Fannounce'

const leecherTorrent = leecher.add(magnetURI, {
  announceList: [['http://localhost:8000/announce']]
})
leecherTorrent.on('download', function (chunkSize) {
  console.log('leecher downloaded ' + chunkSize)
})
leecherTorrent.on('done', function () {
  console.log('leecher done, downloaded ' + leecherTorrent.files.length + ' files')
})