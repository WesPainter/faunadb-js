import {InvalidQuery, InvalidValue} from '../errors'
import {Page, PageIterator, Ref} from '../objects'
import * as query from '../query'
import Field from './Field'
import {calculateDiff, getPath, objectDup, setPath} from './_util'

/**
 * Base class for all models.
 *
 * Models represent database instances.
 * They link a FaunaDB class to a JavaScript class.
 *
 * The basic format is:
 *
 *     class MyModel extends Model {
 *       ... your methods ...
 *     }
 *     // define class name and fields
 *     MyModel.setup('my_models', {
 *       x: {},
 *       y: {converter: new RefConverter(MyModel)}
 *     })
 *
 * {@link Field}s will be constructed and
 * properties will be generated for each field passed to {@link setup}.
 *
 * {@link Class.createForModel} must be called before you can save model instances.
 */
export default class Model {
  /**
   * @param {string} faunaClassName
   * @param {object} fields
   *   Each `key: value` pair is the parameters for `addField`.
   */
  static setup(faunaClassName, fields={}) {
    this.faunaClassName = faunaClassName
    /**
     * {@link Ref} for the class itself.
     *
     * `instance.ref` should be the same as `new Ref(instance.constructor.classRef, instance.id)`.
     */
    this.classRef = new Ref('classes', faunaClassName)
    /** Object of all fields assigned to this class. */
    this.fields = {}
    for (const fieldName in fields)
      this.addField(fieldName, fields[fieldName])
  }

  /**
   * Adds a new field to the class, making getters and setters.
   *
   * @param {string} fieldName
   *   Name for the field. A getter and setter will be made with this name.
   *   If `fieldOpts.path` is not defined, it defaults to `['data', fieldName]`.
   * @param {object} fieldOpts
   *   Parameters for the {@link Field} constructor.
   */
  static addField(fieldName, fieldOpts={}) {
    if (fieldName === 'ref' || fieldName === 'ts')
      throw new Error('Forbidden field name.')

    if (fieldOpts.path == null)
      fieldOpts.path = ['data', fieldName]
    const field = new Field(fieldOpts)
    this.fields[fieldName] = field

    const {get, set} = field.codec === null ?
      {
        get() {
          return getPath(field.path, this._current)
        },
        set(value) {
          setPath(field.path, value, this._current)
        }
      } : {
        get() {
          if (fieldName in this._cache)
            return this._cache[fieldName]
          else {
            const encoded = getPath(field.path, this._current)
            const decoded = field.codec.decode(encoded, this)
            this._cache[fieldName] = decoded
            return decoded
          }
        },
        set(value) {
          this._cache[fieldName] = value
          const encoded = field.codec.encode(value, this)
          setPath(field.path, encoded, this._current)
        }
      }
    Object.defineProperty(this.prototype, fieldName, {get, set})
  }

  /**
   * Initialize (but do not save) a new instance.
   * @param {Client} client
   * @param {object} data Fields to be set.
   */
  constructor(client, data) {
    /** Client instance that the model uses to save to the database. */
    this.client = client

    this._original = {}
    this._initState()

    for (const fieldName in data) {
      if (!(fieldName in this.constructor.fields))
        throw new InvalidValue(`No such field ${fieldName}`)
      // This calls the field's setter.
      this[fieldName] = data[fieldName]
    }
  }

  /** {@link Ref} of this instance in the database. Fails if {@link isNewInstance}. */
  get ref() {
    if (this.isNewInstance())
      throw new InvalidQuery('Instance has not been saved to the database, so no ref exists.')
    return this._current.ref
  }

  /** The id portion of this instance's {@link Ref}. Fails if {@link isNewInstance}. */
  get id() {
    return this.ref.id
  }

  /**
   * Microsecond UNIX timestamp of the latest {@link save}.
   * Fails if {@link isNewInstance}.
   */
  get ts() {
    if (this.isNewInstance())
      throw new InvalidQuery('Instance has not been saved to the database, so no ts exists.')
    return this._current.ts
  }

  /** For a field with a {@link Converter}s, gets the encoded value. */
  getEncoded(fieldName) {
    const field = this.constructor.fields[fieldName]
    return getPath(field.path, this._current)
  }

  /** `false` if this has ever been saved to the database. */
  isNewInstance() {
    return !('ref' in this._current)
  }

  /** Removes this instance from the database. */
  async delete() {
    return await this.client.query(this.deleteQuery())
  }

  /** Query that deletes this instance. */
  deleteQuery() {
    if (this.isNewInstance())
      throw new InvalidQuery('Instance does not exist in the database.')
    return query.delete_expr(this.ref)
  }

  /** Executes {@link saveQuery}. */
  async save(replace=false) {
    this._initFromResource(await this.client.query(this.saveQuery(replace)))
  }

  /**
   * Query to save this instance to the database.
   * If {@link isNewInstance}, creates it and sets `ref` and `ts`.
   * Otherwise, updates any changed fields.
   *
   * @param replace
   *   If true, updates will update *all* fields
   *   using {@link replaceQuery} instead of {@link updateQuery}.
   *   See the [docs](https://faunadb.com/documentation/queries#write_functions).
   */
  saveQuery(replace=false) {
    return this.isNewInstance() ?
      this.createQuery() :
      replace ? this.replaceQuery() : this.updateQuery()
  }

  /** Query to create a new instance. */
  createQuery() {
    if (!this.isNewInstance())
      throw new InvalidQuery('Trying to create instance that has already been created.')
    return query.create(this.constructor.classRef, query.quote(this._current))
  }

  /** Query to replace this instance's data. */
  replaceQuery() {
    if (this.isNewInstance())
      throw new InvalidQuery('Instance has not yet been created.')
    return query.replace(this.ref, query.quote(this._current))
  }

  /** Query to update this instance's data. */
  updateQuery() {
    if (this.isNewInstance())
      throw new InvalidQuery('Instance has not yet been created.')
    return query.update(this.ref, query.quote(this._diff()))
  }

  /** A Model class is considered abstract if {@link setup} was never called. */
  static isAbstract() {
    return this.faunaClassName === undefined
  }

  /** Gets the instance of this class specified by `ref`. */
  static async get(client, ref) {
    return this.getFromResource(client, await client.get(ref))
  }

  /** Gets the instance of this class specified by `id`. */
  static async getById(client, instanceId) {
    return await this.get(client, new Ref(this.classRef, instanceId))
  }

  /** Initializes and saves a new instance. */
  static async create(client, data) {
    const instance = new this(client, data)
    instance._initFromResource(await client.post(this.classRef, instance._current))
    return instance
  }

  /** Creates a new instance from query results. */
  static getFromResource(client, resource) {
    const instance = new this(client)
    instance._initFromResource(resource)
    return instance
  }

  _initFromResource(resource) {
    if (!(typeof resource === 'object' && resource.constructor === Object))
      throw new Error('Expected to initialize from plain object resource.')
    const expectedClass = this.constructor.classRef
    if (!resource.class.equals(expectedClass))
      throw new InvalidValue(
        `Trying to initialize from resource of class ${resource.class}; expected ${expectedClass}`)

    this._original = resource
    this._initState()
  }

  _initState() {
    // New JSON data of the instance.
    this._current = objectDup(this._original)
    // Maps from field names to decoded values. Only used for fields with a codec.
    this._cache = {}
  }

  _diff() {
    return calculateDiff(this._original, this._current)
  }

  /**
   * Paginates a set query and converts results to instances of this class.
   *
   * @param {Client} client
   * @param instanceSet Query set of instances of this class.
   * @param pageParams Params to {@link query.paginate}.
   */
  static async page(client, instanceSet, pageParams={}) {
    return await this._mapPage(client, instanceSet, query.lambda(query.get), pageParams)
  }

  /**
   * Calls {@link Index.match} and then works just like {@link page}.
   *
   * @param {Index} index
   * @param matchedValues Values for {@link Index.match}.
   * @param pageParams Params to {@link query.paginate}.
   */
  static async pageIndex(index, matchedValues, pageParams={}) {
    if (!(matchedValues instanceof Array))
      matchedValues = [matchedValues]
    const client = index.client
    const matchSet = index.match(...matchedValues)
    const getter = indexRefGetter(index)
    return this._mapPage(client, matchSet, getter, pageParams)
  }

  static async _mapPage(client, instanceSet, pageLambda, pageParams) {
    const pageQuery = query.paginate(instanceSet, pageParams)
    const mapQuery = query.map(pageLambda, pageQuery)
    const page = Page.fromRaw(await client.query(mapQuery))
    return page.mapData(resource => this.getFromResource(client, resource))
  }

  /**
   * Returns a PageIterator for `instanceSet` that converts results to model instances.
   * @param {Client} client
   * @param instanceSet Query set of {@link Ref}s to instances of this class.
   * @param [pageSize] Size of each page.
   */
  static pageIterator(client, instanceSet, pageSize=null) {
    return new PageIterator(client, instanceSet, {
      pageSize,
      mapLambda: query.lambda(query.get),
      map: instance => this.getFromResource(client, instance)
    })
  }

  /**
   * @param {Index} index Index whose instances are instances of this class.
   * @param matchedValues Matched value or array of matched values, passed into {@link Index.match}.
   * @param [pageSize] Size of each page.
   */
  static pageIteratorForIndex(index, matchedValues, pageSize=null) {
    const client = index.client
    if (!(matchedValues instanceof Array))
      matchedValues = [matchedValues]
    const matchSet = index.match(...matchedValues)

    return new PageIterator(client, matchSet, {
      pageSize,
      mapLambda: indexRefGetter(index),
      map: instance => this.getFromResource(client, instance)
    })
  }

  /** @ignore */
  toString() {
    const fields = Object.keys(this.constructor.fields).map(key =>
      `${key}: ${this[key]}`).join(', ')
    return `${this.constructor.name}(${fields})`
  }
}

/** Lambda expression for getting an instance Ref out of a match result. */
const indexRefGetter = index =>
  index.values ?
    query.lambda(arr => query.get(query.select(index.values.length, arr))) :
    query.lambda(query.get)
