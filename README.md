# WebTorrent-ILP

> A modified version of the [WebTorrent](https://github.com/feross/webtorrent) client that pays content creators and seeders using the [Interledger Protocol (ILP)](https://interledger.org).

To see it in action go to https://instant-io-ilp.herokuapp.com/

## Installation

```sh
npm install https://github.com/emschwartz/webtorrent-ilp
```

## Usage

```js
'use strict'

const WebTorrentIlp = require('webtorrent-ilp')
const client = new WebTorrentIlp({
  address: 'alice@red.ilpdemo.org',
  password: 'alice',
  price: '0.0001', // per kilobyte
  // publicKey: 'Hq/8TtlPg0E+8ThqQV8ZL3aPGsMXg9jmpWyZLtlpCkg=' // ed25519 public key, optional
  // Options will also be passed through to WebTorrent
})

client.seed(...)
client.download(...)
// The client will take care of paying for the licenses and content automagically

// See WebTorrent docs for more on usage: https://github.com/feross/webtorrent/blob/master/docs/get-started.md
```

## API

### client = new WebTorrentIlp([opts])

See [WebTorrent docs](https://github.com/feross/webtorrent/blob/master/docs/api.md#client--new-webtorrentopts)

### client.seed

See [WebTorrent docs](https://github.com/feross/webtorrent/blob/master/docs/api.md#clientseedinput-opts-function-onseed-torrent-)

### client.download

See [WebTorrent docs](https://github.com/feross/webtorrent/blob/master/docs/api.md#clientaddtorrentid-opts-function-ontorrent-torrent-)

### Events

#### `'wallet_ready'`

```js
client.on('wallet_ready', function () {
  // client is ready to send payments and receive notifications of incoming payments
})
```

#### `'incoming_payment'`

```js
client.on('incoming_payment', function (paymentDetails) {
  console.log(paymentDetails.peerPublicKey) // 'Cyh5tHkF6G1lJUAFSSOm1NfYAn3nYLW8k+lNRL2JjFQ=''
  console.log(paymentDetails.amount) // '0.01'
})
```

#### `'license'`

```js
client.on('license', function (torrentHash, license) {
  console.log(torrentHash) // '567820be738f5b33f515884d1e059ad68bc96e3f'
  console.log(JSON.stringify(license)) // '{ "creator_account": "https://red.ilpdemo.org/ledger/accounts/alice", "creator_public_key": "r/MV0THsvdcUAw7Y8x8ca2/dEc8gXRQNDapQ6xFUG3E=", "license_type": "https://interledger.org/licenses/1.0/mpay", "price_per_minute": "0.0001", "expires_at": "2016-04-09T23:39:59.153Z", "signature": "dqT0wqOxg8mt6fOuRe03NuaVKrXIo07IcwGuR4cqw9aeJ6lq0psg86bDIEKYB1qRaXX8iIrm8cnWi+eViqJDBg==" }'
})
```


