'use strict'

const WebTorrentIlp = require('./index')

const leecher = new WebTorrentIlp({
  walletUri: 'https://blue.ilpdemo.org',
  username: 'alice',
  password: 'alice',
  license: {
    content_hash: 'a3734717a96baaf7ab9afad20ac47371066acc6a',
    creator_account: "https://red.ilpdemo.org/ledger/accounts/walt",
    creator_public_key: "QwRCBaiU95sIYi19/A4PqSpz93lQpchheiS1BVtlnVM=",
    license: "https://creativecommons.org/licenses/pay/1.0",
    licensee_public_key: 'lfFMEl9mWw56HygZGYejElw64wnKschRQSzu+JuZkVw=',
    expires_at: '2016-06-01T12:00:00Z',
    signature: 'thanks!'
  }
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