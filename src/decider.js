import Debug from 'debug'
const debug = Debug('WebTorrentIlp:Decider')
import JSData from 'js-data'
import uuid from 'uuid'
import BigNumber from 'bignumber.js'
import moment from 'moment'

export default class Decider {
  constructor (opts) {
    this.store = new JSData.DS()
    // TODO don't use uuids, maybe use incrementing numbers to reduce memory
    // TODO use relations to avoid storing the publicKey and torrentHash many times over
    this.Payment = this.store.defineResource({
      name: 'payment',
      computed: {
        id: ['id', (id) => id || uuid.v4()]
      }
    })
    this.PaymentRequest = this.store.defineResource({
      name: 'payment_request',
      computed: {
        id: ['id', (id) => id || uuid.v4()]
      }
    })
    this.Delivery = this.store.defineResource({
      name: 'delivery',
      computed: {
        id: ['id', (id) => id || uuid.v4()]
      }
    })
  }

  shouldSendPayment (paymentRequest) {
    const { publicKey, torrentHash } = paymentRequest
    return this.recordPaymentRequest(paymentRequest)
      .then(() => {
        debug('checking if we shouldSendPayment')

        const peerCostPerByte = this.getCostPerByte({ publicKey, torrentHash })
        debug('peerCostPerByte: ' + peerCostPerByte.toString() + ' (' + publicKey.slice(0, 8) + ')')
        if (!peerCostPerByte.isFinite()) {
          return false
        }
        const torrentCostPerByte = this.getCostPerByte({ torrentHash })
        debug('torrentCostPerByte: ' + torrentCostPerByte.toString())

        // Check if there is a cheaper or faster peer
        const peerSpeed = this.getSpeed({ publicKey, torrentHash, includeTimeToNow: true })
        const torrentSpeed = this.getSpeed({ torrentHash, includeTimeToNow: true })
        debug('peerSpeed: ' + peerSpeed.toString() + ' (' + publicKey.slice(0, 8) + ')')
        debug('torrentSpeed: ' + torrentSpeed.toString())

        const numPaymentsInLastTenSeconds = this.getNumPaymentsSinceDate({ publicKey, torrentHash, date: moment().subtract(10, 'seconds') })
        debug('numPaymentsInLastTenSeconds: ' + numPaymentsInLastTenSeconds.toString())
        const maxPaymentsPerTenSeconds = 2
        if (numPaymentsInLastTenSeconds.greaterThan(maxPaymentsPerTenSeconds)) {
          return false
        }

        // TODO @tomorrow create models for the peers that automatically track their speed and cost

        return true
      })
  }

  recordPaymentRequest (paymentRequest) {
    debug('Got payment request %o', paymentRequest)
    return Promise.resolve(this.PaymentRequest.inject(paymentRequest))
  }

  recordPayment (payment) {
    debug('recordPayment %o', payment)
    return Promise.resolve(this.Payment.inject(payment))
  }

  recordFailedPayment (paymentId, err) {
    debug('recordFailedPayment %o Error: %o', paymentId, err)
    return Promise.resolve(this.Payment.eject(paymentId))
  }

  recordDelivery (delivery) {
    debug('recordDelivery %o', delivery)
    return Promise.resolve(this.Delivery.inject(delivery))
  }

  getTotalSent (filters) {
    const payments = this.Payment.filter(filters)
    return sum(payments, 'sourceAmount')
  }

  getBytesDelivered (filters) {
    const deliveries = this.Delivery.filter(filters)
    return sum(deliveries, 'bytes')
  }

  getCostPerByte (filters) {
    const totalSent = this.getTotalSent(filters)
    const bytesDelivered = this.getBytesDelivered(filters)
    if (totalSent.equals(0)) {
      return new BigNumber(0)
    }
    return totalSent.div(bytesDelivered)
  }

  getSpeed ({ publicKey, torrentHash, includeTimeToNow }) {
    let query = {
      where: {
        torrentHash: {
          '===': torrentHash
        }
      },
      orderBy: [['timestamp', 'ASC']]
    }
    if (publicKey) {
      query.where.publicKey = { '===': publicKey }
    }
    const deliveries = this.Delivery.filter(query)
    if (!deliveries || deliveries.length === 0) {
      return new BigNumber(0)
    }
    let timeSpan
    if (includeTimeToNow) {
      timeSpan = moment().diff(deliveries[0].timestamp)
    } else {
      timeSpan = moment(deliveries[deliveries.length - 1]).diff(deliveries[0].timestamp)
    }
    const bytesDelivered = sum(deliveries, 'bytes')
    return bytesDelivered.div(timeSpan)
  }

  getNumPaymentsSinceDate ({ publicKey, torrentHash, date }) {
    let query = {
      where: {}
    }
    if (publicKey) {
      query.where.publicKey = { '===': publicKey }
    }
    if (torrentHash) {
      query.where.torrentHash = { '===': torrentHash }
    }
    if (date) {
      query.where.timestamp = { '>=': date.toString() }
    }
    const payments = this.Payment.filter(query)
    return payments.length
  }
}

function sum (arr, key) {
  let total = new BigNumber(0)
  for (let item of arr) {
    total = total.plus(item[key])
  }
  return total
}
