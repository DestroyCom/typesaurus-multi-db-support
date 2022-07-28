import * as firestore from '@google-cloud/firestore'
import * as admin from 'firebase-admin'
import { Typesaurus } from '../..'
import { TypesaurusUtils } from '../../utils'

class DocId {}

/**
 * A special sentinel to refer to the ID of a document.
 * It can be used in queries to sort or filter by the document ID.
 *
 * ```ts
 * import { docId, query, collection, where } from 'typesaurus'
 *
 * type Word = { definition: string }
 * const dictionary = collection<Word>('words')
 *
 * query(dictionary, [
 *   where(docId, '>=', 'micro'),
 *   where(docId, '<', 'micrp'),
 *   limit(2)
 * ]).then(startsWithMicro => {
 *   // possibly returns a word list start with 'micro'.
 * })
 * ```
 */
const docId = new DocId()

type typeofDocId = string // just for documenting.

export { DocId, docId, typeofDocId }

export const defaultOnMissing: Typesaurus.OnMissingCallback<unknown> = (id) => {
  throw new Error(`Missing document with id ${id}`)
}

export function schema<Schema extends Typesaurus.PlainSchema>(
  getSchema: ($: Typesaurus.SchemaHelpers) => Schema
): Typesaurus.RootDB<Schema> {
  const schemaHelpers: Typesaurus.SchemaHelpers = {
    collection() {
      return { type: 'collection' }
    },

    sub(collection, schema) {
      return { ...collection, schema }
    }
  }

  const db = getSchema(schemaHelpers)

  const richdb: Typesaurus.RichSchema = {}

  Object.entries(db).forEach(([collectionPath, collection]) => {
    richdb[collectionPath] = new RichCollection(collectionPath)
  })

  return richdb as unknown as Typesaurus.RootDB<Schema>
}

export async function id() {
  return admin.firestore().collection('nope').doc().id
}

class RichCollection<Model> implements Typesaurus.RichCollection<Model> {
  path: string

  constructor(path: string) {
    this.path = path
  }

  ref(id: string) {
    return new Ref<Model>(this, id)
  }

  doc(id: string, data: Model) {
    return new Doc<Model>(this, id, data)
  }

  async add<Environment extends Typesaurus.RuntimeEnvironment>(
    getData: Typesaurus.WriteModelArg<Model, Environment>
  ) {
    const data =
      typeof getData === 'function' ? getData(this.writeHelpers()) : getData
    const firebaseRef = await this.firebaseCollection().add(unwrapData(data))
    return this.ref(firebaseRef.id)
  }

  async set<Environment extends Typesaurus.RuntimeEnvironment>(
    id: string,
    data: Typesaurus.WriteModelArg<Model, Environment>
  ) {
    await this.firebaseDoc(id).set(unwrapData(data))
  }

  async upset<Environment extends Typesaurus.RuntimeEnvironment>(
    id: string,
    data: Typesaurus.WriteModelArg<Model, Environment>
  ) {
    const dataToUpset =
      typeof data === 'function' ? data(this.writeHelpers()) : data
    await this.firebaseDoc(id).set(unwrapData(dataToUpset), { merge: true })
  }

  async update<Environment extends Typesaurus.RuntimeEnvironment>(
    id: string,
    data: Typesaurus.UpdateModelArg<Model, Environment>
  ) {
    const updateData =
      typeof data === 'function' ? data(this.updateHelpers()) : data

    const update = Array.isArray(updateData)
      ? updateData.reduce((acc, field) => {
          if (!field) return
          const { key, value } = field
          acc[Array.isArray(key) ? key.join('.') : key] = value
          return acc
        }, {} as { [key: string]: any })
      : updateData

    await this.firebaseDoc(id).update(unwrapData(update))
  }

  all(): Typesaurus.PromiseWithListSubscription<Model> {
    const firebaseCollection = admin.firestore().collection(this.path)

    return new TypesaurusUtils.SubscriptionPromise<Typesaurus.Doc<Model>[]>({
      get: async () => {
        const snapshot = await this.firebaseCollection().get()
        return snapshot.docs.map(
          (doc) => new Doc<Model>(this, doc.id, wrapData(doc.data()))
        )
      },

      subscribe: (onResult, onError) =>
        firebaseCollection.onSnapshot((snapshot) => {
          onResult(
            snapshot.docs.map(
              (doc) => new Doc<Model>(this, doc.id, wrapData(doc.data()))
            )
          )
        }, onError)
    })
  }

  get(id: string) {
    return new TypesaurusUtils.SubscriptionPromise({
      get: async () => {
        const firebaseSnap = await this.firebaseDoc(id).get()
        const data = firebaseSnap.data()
        if (data) return this.doc(id, wrapData(firebaseSnap.data()))
        return null
      },

      subscribe() {}
    })
  }

  getMany<
    OnMissing extends Typesaurus.OnMissingMode<unknown> | undefined = undefined
  >(
    ids: string[],
    options?: Typesaurus.GetManyOptions<OnMissing>
  ) /* : OnMissing extends 'ignore' | undefined
    ? Typesaurus.PromiseWithListSubscription<Model>
    : OnMissing extends Typesaurus.OnMissingCallback<infer OnMissingResult>
    ? Typesaurus.PromiseWithListSubscription<Model | OnMissingResult>
    : never*/ {
    return new TypesaurusUtils.SubscriptionPromise({
      get: async () => {
        // Firestore#getAll doesn't like empty lists
        if (ids.length === 0) return Promise.resolve([])

        const firestoreSnaps = await admin
          .firestore()
          .getAll(...ids.map((id) => this.firebaseDoc(id)))

        return firestoreSnaps
          .map((firestoreSnap) => {
            if (!firestoreSnap.exists) {
              if (options?.onMissing === 'ignore') {
                return null
              } else {
                return this.doc(
                  firestoreSnap.id,
                  (options?.onMissing || defaultOnMissing)(firestoreSnap.id)
                  // {
                  //   firestoreData: true,
                  //   environment: a.environment,
                  //   serverTimestamps: options?.serverTimestamps,
                  //   ...a.getDocMeta(firestoreSnap)
                  // }
                )
              }
            }

            const firestoreData = firestoreSnap.data()
            const data = firestoreData && (wrapData(firestoreData) as Model)
            return this.doc(
              firestoreSnap.id,
              data /*, {
              firestoreData: true,
              environment: a.environment,
              serverTimestamps: options?.serverTimestamps,
              ...a.getDocMeta(firestoreSnap)
            } */
            )
          })
          .filter((doc) => doc != null)
      },

      subscribe() {}
    })
  }

  async query(getQueries: Typesaurus.QueryGetter<Model>) {
    const queries = getQueries(this.queryHelpers())
    // Query accumulator, will contain final Firestore query with all the
    // filters and limits.
    let firestoreQuery: admin.firestore.Query = this.firebaseCollection()

    let cursors: Typesaurus.OrderCursor<any, any, any>[] = []

    queries.forEach((query) => {
      switch (query.type) {
        case 'order': {
          const { field, method, cursors: queryCursors } = query
          firestoreQuery = firestoreQuery.orderBy(
            field instanceof DocId
              ? admin.firestore.FieldPath.documentId()
              : field.toString(),
            method
          )

          if (queryCursors)
            cursors = cursors.concat(
              queryCursors.map(({ type, position, value }) => ({
                type,
                position,
                value:
                  typeof value === 'object' &&
                  value !== null &&
                  'type' in value &&
                  value.type == 'doc'
                    ? field instanceof DocId
                      ? value.ref.id
                      : value.data[field]
                    : value
              }))
            )
          break
        }

        case 'where': {
          const { field, filter, value } = query
          const fieldName = Array.isArray(field) ? field.join('.') : field
          firestoreQuery = firestoreQuery.where(
            fieldName instanceof DocId
              ? admin.firestore.FieldPath.documentId()
              : fieldName,
            filter,
            unwrapData(value)
          )
          break
        }

        case 'limit': {
          const { number } = query
          firestoreQuery = firestoreQuery.limit(number)
          break
        }
      }
    })

    let groupedCursors: [Typesaurus.OrderCursorPosition, any[]][] = []

    cursors.forEach((cursor) => {
      let methodValues = groupedCursors.find(
        ([position]) => position === cursor.position
      )
      if (!methodValues) {
        methodValues = [cursor.position, []]
        groupedCursors.push(methodValues)
      }
      methodValues[1].push(unwrapData(cursor.value))
    })

    if (cursors.length && cursors.every((cursor) => cursor.value !== undefined))
      groupedCursors.forEach(([method, values]) => {
        firestoreQuery = firestoreQuery[method](...values)
      })

    return new TypesaurusUtils.SubscriptionPromise<
      Typesaurus.PromiseWithListSubscription<Model>
    >({
      get: async () => {
        const firebaseSnap = await firestoreQuery.get()
        return firebaseSnap.docs.map((firebaseSnap) =>
          this.doc(
            firebaseSnap.id,
            // collection.__type__ === 'collectionGroup'
            //   ? pathToRef(firebaseSnap.ref.path)
            //   : ref(collection, firebaseSnap.id),
            // wrapData(a.getDocData(firebaseSnap, options)) as Model,
            wrapData(firebaseSnap.data()) as Model
            // {
            //   firestoreData: true,
            //   environment: a.environment as Environment,
            //   serverTimestamps: options?.serverTimestamps,
            //   ...a.getDocMeta(firebaseSnap)
            // }
          )
        )
      },

      subscribe() {}
    })
  }

  async remove(id: string) {
    await this.firebaseDoc(id).delete()
  }

  private queryHelpers(): Typesaurus.QueryHelpers<Model> {
    return {
      where: (field, filter, value) => ({
        type: 'where',
        field,
        filter,
        value
      }),

      order: (field, ...args) => ({
        type: 'order',
        field,
        method: typeof args[0] === 'string' ? args[0] : 'asc',
        cursors:
          args.length > 1
            ? args.slice(1)
            : typeof args[0] === 'object'
            ? args
            : undefined
      }),

      limit: (number) => ({
        type: 'limit',
        number
      }),

      startAt: (value) => ({
        type: 'cursor',
        position: 'startAt',
        value
      }),

      startAfter: (value) => ({
        type: 'cursor',
        position: 'startAfter',
        value
      }),

      endAt: (value) => ({
        type: 'cursor',
        position: 'endAt',
        value
      }),

      endBefore: (value) => ({
        type: 'cursor',
        position: 'endBefore',
        value
      }),

      docId: () => docId
    }
  }

  private writeHelpers(): Typesaurus.WriteHelpers<Model> {
    return {
      serverDate: () => ({ type: 'value', kind: 'serverDate' }),

      remove: () => ({ type: 'value', kind: 'remove' }),

      increment: (number) => ({
        type: 'value',
        kind: 'increment',
        number
      }),

      arrayUnion: (values) => ({
        type: 'value',
        kind: 'arrayUnion',
        values: [].concat(values)
      }),

      arrayRemove: (values) => ({
        type: 'value',
        kind: 'arrayRemove',
        values: [].concat(values)
      })
    }
  }

  private firebaseCollection() {
    return admin.firestore().collection(this.path)
  }

  private firebaseDoc(id: string) {
    return admin.firestore().doc(`${this.path}/${id}`)
  }
}

class Ref<Model> implements Typesaurus.Ref<Model> {
  type: 'ref'

  collection: Typesaurus.RichCollection<Model>

  id: string

  constructor(collection: Typesaurus.RichCollection<Model>, id: string) {
    this.type = 'ref'
    this.collection = collection
    this.id = id
  }

  get() {
    return this.collection.get(this.id)
  }

  set<Environment extends Typesaurus.RuntimeEnvironment>(
    data: Typesaurus.WriteModelArg<Model, Environment>
  ) {
    return this.collection.set(this.id, data)
  }

  upset<Environment extends Typesaurus.RuntimeEnvironment>(
    data: Typesaurus.WriteModelArg<Model, Environment>
  ) {
    return this.collection.upset(this.id, data)
  }

  update<Environment extends Typesaurus.RuntimeEnvironment>(
    data: Typesaurus.UpdateModelArg<Model, Environment>
  ) {
    return this.collection.update(this.id, data)
  }

  async remove() {
    await this.collection.remove(this.id)
  }

  private firebaseDoc() {
    return admin.firestore().doc(`${this.collection.path}/${this.id}`)
  }
}

class Doc<Model> implements Typesaurus.ServerDoc<Model> {
  type: 'doc'

  ref: Typesaurus.Ref<Model>

  collection: Typesaurus.RichCollection<Model>

  data: Typesaurus.ModelNodeData<Model>

  environment: 'server'

  constructor(
    collection: Typesaurus.RichCollection<Model>,
    id: string,
    data: Model
  ) {
    this.type = 'doc'
    this.collection = collection
    this.ref = new Ref<Model>(collection, id)
    this.data = data
    this.environment = 'server'
  }

  get() {
    return this.ref.get()
  }

  update(update) {
    return this.ref.update(update)
  }

  upset(data) {
    return this.ref.upset(data)
  }

  async remove() {
    await this.ref.remove()
  }
}

/**
 * Generates Firestore path from a reference.
 *
 * @param ref - The reference to a document
 * @returns Firestore path
 */
export function getRefPath<Model>(ref: Typesaurus.Ref<Model>) {
  return [ref.collection.path].concat(ref.id).join('/')
}

/**
 * Creates Firestore document from a reference.
 *
 * @param ref - The reference to create Firestore document from
 * @returns Firestore document
 */
export function refToFirestoreDocument<Model>(ref: Typesaurus.Ref<Model>) {
  return admin.firestore().doc(getRefPath(ref))
}

/**
 * Creates a reference from a Firestore path.
 *
 * @param path - The Firestore path
 * @returns Reference to a document
 */
export function pathToRef<Model>(path: string): Typesaurus.Ref<Model> {
  const captures = path.match(/^(.+)\/(.+)$/)
  if (!captures) throw new Error(`Can't parse path ${path}`)
  const [, collectionPath, id] = captures
  return new Ref<Model>(new RichCollection<Model>(collectionPath), id)
}

/**
 * Converts Typesaurus data to Firestore format. It deeply traverse all the data and
 * converts values to compatible format.
 *
 * @param data - the data to convert
 * @returns the data in Firestore format
 */
export function unwrapData(data: any): any {
  if (data && typeof data === 'object') {
    if (data.type === 'ref') {
      return refToFirestoreDocument(data as Typesaurus.Ref<unknown>)
    } else if (data.type === 'value') {
      const fieldValue = data as Typesaurus.Value<any>
      switch (fieldValue.kind) {
        case 'remove':
          return firestore.FieldValue.delete()
        case 'increment':
          return firestore.FieldValue.increment(fieldValue.number)
        case 'arrayUnion':
          return firestore.FieldValue.arrayUnion(
            ...unwrapData(fieldValue.values)
          )
        case 'arrayRemove':
          return firestore.FieldValue.arrayRemove(
            ...unwrapData(fieldValue.values)
          )
        case 'serverDate':
          return firestore.FieldValue.serverTimestamp()
      }
    } else if (data instanceof Date) {
      return firestore.Timestamp.fromDate(data)
    }

    const unwrappedObject: { [key: string]: any } = Object.assign(
      Array.isArray(data) ? [] : {},
      data
    )
    Object.keys(unwrappedObject).forEach((key) => {
      unwrappedObject[key] = unwrapData(unwrappedObject[key])
    })
    return unwrappedObject
  } else if (data === undefined) {
    return null
  } else {
    return data
  }
}

/**
 * Converts Firestore data to Typesaurus format. It deeply traverse all the
 * data and converts values to compatible format.
 *
 * @param data - the data to convert
 * @returns the data in Typesaurus format
 */
export function wrapData(data: any): any {
  if (data instanceof firestore.DocumentReference) {
    return pathToRef(data.path)
  } else if (data instanceof firestore.Timestamp) {
    return data.toDate()
  } else if (data && typeof data === 'object') {
    const wrappedData: { [key: string]: any } = Object.assign(
      Array.isArray(data) ? [] : {},
      data
    )
    Object.keys(wrappedData).forEach((key) => {
      wrappedData[key] = wrapData(wrappedData[key])
    })
    return wrappedData
  } else {
    return data
  }
}

/**
 * Deeply replaces all `undefined` values in the data with `null`. It emulates
 * the Firestore behavior.
 *
 * @param data - the data to convert
 * @returns the data with undefined values replaced with null
 */
export function nullifyData(data: any): any {
  if (data && typeof data === 'object' && !(data instanceof Date)) {
    const newData: typeof data = Array.isArray(data) ? [] : {}
    for (const key in data) {
      newData[key] = data[key] === undefined ? null : nullifyData(data[key])
    }
    return newData
  } else {
    return data
  }
}