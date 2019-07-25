import assert from 'assert'
import nanoid from 'nanoid'
import { getRefPath, ref, pathToRef } from '.'
import { collection } from '../collection'

describe('Ref', () => {
  interface User {
    name: string
  }
  const users = collection<User>('users')

  describe('ref', () => {
    it('creates ref object', () => {
      assert.deepEqual(ref(users, '42'), {
        __type__: 'ref',
        id: '42',
        collection: users
      })
    })
  })

  describe('getRefPath', () => {
    it('returns full document path', () => {
      assert(
        getRefPath({
          __type__: 'ref',
          id: '42',
          collection: users
        }) === 'users/42'
      )
    })
  })

  describe('pathToRef', () => {
    it('returns full document path', () => {
      assert.deepEqual(pathToRef('users/42'), {
        __type__: 'ref',
        id: '42',
        collection: users
      })
    })
  })
})
