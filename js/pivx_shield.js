import bs58 from "bs58";
import { v4 as genuuid } from "uuid";

export class PIVXShield {
  /**
   * Webassembly object that holds Shield related functions
   * @private
   */
  #shieldWorker;

  /**
   * Extended spending key
   * @type {string}
   * @private
   */
  #extsk;

  /**
   * Extended full viewing key
   * @type {string}
   * @private
   */
  #extfvk;

  /**
   * Diversifier index of the last generated address.
   * @private
   */
  #diversifierIndex = new Uint8Array(11);

  /**
   * @type {boolean}
   * @private
   */
  #isTestnet;

  /**
   * Last processed block in the blockchain
   * @type {number}
   * @private
   */
  #lastProcessedBlock;

  /**
   * Hex encoded commitment tree
   * @type {string}
   * @private
   */
  #commitmentTree;

  /**
   * Array of notes, corresponding witness
   * @type {[Note, string][]}
   * @private
   */
  #unspentNotes = [];

  /**
   * @type {Map<string, string[]>} A map txid->nullifiers, storing pending transaction.
   * @private
   */

  #pendingSpentNotes = new Map();

  /**
   * @type {Map<string, Note[]>} A map txid->Notes, storing incoming spendable notes.
   * @private
   */
  #pendingUnspentNotes = new Map();

  /**
   * @type{Map<string, {res: (...args: any) => void, rej: (...args: any) => void}>}
   */
  #promises = new Map();

  #initWorker() {
    this.#shieldWorker.onmessage = (msg) => {
      const { res, rej } = this.#promises.get(msg.data.uuid);
      if (msg.data.rej) {
        rej(msg.data.rej);
      } else {
        res(msg.data.res);
      }
      this.#promises.delete(msg.data.uuid);
    };
  }

  async #callWorker(name, ...args) {
    const uuid = genuuid();
    return await new Promise((res, rej) => {
      this.#promises.set(uuid, { res, rej });
      this.#shieldWorker.postMessage({ uuid, name, args });
    });
  }
  /**
   * Creates a PIVXShield object
   * @param {object} o - options
   * @param {number[]?} o.seed - array of 32 bytes that represents a random seed.
   * @param {string?} o.extendedSpendingKey - Extended Spending Key.
   * @param {string?} o.extendedFullViewingKey - Full viewing key
   * @param {number} o.blockHeight - number representing the block height of creation of the wallet
   * @param {number} o.coinType - number representing the coin type, 1 represents testnet
   * @param {number} o.accountIndex - index of the account that you want to generate, by default is set to 0
   * @param {boolean} o.loadSaplingData - if you want to load sapling parameters on creation, by deafult is set to true
   */
  static async create({
    seed,
    extendedSpendingKey,
    extendedFullViewingKey,
    blockHeight,
    coinType,
    accountIndex = 0,
    loadSaplingData = true,
  }) {
    if (!extendedSpendingKey && !seed && !extendedFullViewingKey) {
      throw new Error(
        "At least one among seed, extendedSpendingKey, extendedFullViewingKey must be provided",
      );
    }

    if (extendedSpendingKey && seed) {
      throw new Error("Don't provide both a seed and an extendedSpendingKey");
    }

    const shieldWorker = new Worker(
      new URL("worker_start.js", import.meta.url),
    );
    await new Promise((res) => {
      shieldWorker.onmessage = (msg) => {
        if (msg.data === "done") res();
      };
    });

    const isTestnet = coinType == 1 ? true : false;

    const pivxShield = new PIVXShield(
      shieldWorker,
      extendedSpendingKey,
      extendedFullViewingKey,
      isTestnet,
      null,
      null,
    );

    if (loadSaplingData) {
      if (!(await pivxShield.loadSaplingProver())) {
        throw new Error("Cannot load sapling data");
      }
    }
    if (seed) {
      const serData = {
        seed: seed,
        coin_type: coinType,
        account_index: accountIndex,
      };
      extendedSpendingKey = await pivxShield.#callWorker(
        "generate_extended_spending_key_from_seed",
        serData,
      );
      pivxShield.#extsk = extendedSpendingKey;
    }
    if (extendedSpendingKey) {
      pivxShield.#extfvk = await pivxShield.#callWorker(
        "generate_extended_full_viewing_key",
        pivxShield.#extsk,
        isTestnet,
      );
    }

    const [effectiveHeight, commitmentTree] = await pivxShield.callWorker(
      "get_closest_checkpoint",
      blockHeight,
      isTestnet,
    );
    pivxShield.lastProcessedBlock = effectiveHeight;
    pivxShield.commitmentTree = commitmentTree;

    return pivxShield;
  }

  /**
   * @private
   */
  constructor(shieldWorker, extsk, extfvk, isTestnet, nHeight, commitmentTree) {
    this.#shieldWorker = shieldWorker;
    this.#extsk = extsk;
    this.#extfvk = extfvk;
    this.#isTestnet = isTestnet;
    this.#lastProcessedBlock = nHeight;

    this.#commitmentTree = commitmentTree;

    this.#initWorker();
  }

  /**
   * Load an extended spending key in order to have spending authority
   * @param {string} enc_extsk - extended spending key
   */
  async loadExtendedSpendingKey(enc_extsk) {
    if (this.#extsk) {
      throw new Error("A spending key is aready loaded");
    }
    const enc_extfvk = await this.#callWorker(
      "generate_extended_full_viewing_key",
      enc_extsk,
      this.#isTestnet,
    );
    if (enc_extfvk !== this.#extfvk) {
      throw new Error("Extended full viewing keys do not match");
    }
    this.#extsk = enc_extsk;
  }

  /**
   * @returns {string} a string that saves the public shield data.
   * The seed or extended spending key still needs to be provided
   * if spending authority is needed
   */
  save() {
    return JSON.stringify(
      new ShieldData({
        extfvk: this.extfvk,
        lastProcessedBlock: this.lastProcessedBlock,
        commitmentTree: this.commitmentTree,
        diversifierIndex: this.diversifierIndex,
        unspentNotes: this.unspentNotes,
        isTestnet: this.isTestnet,
        defaultAddress: address,
        lastProcessedBlock: this.#lastProcessedBlock,
        commitmentTree: this.#commitmentTree,
        diversifierIndex: this.#diversifierIndex,
        unspentNotes: this.#unspentNotes,
      }),
    );
  }

  /**
   * Creates a PIVXShield object from shieldData
   * @param {String} data - output of save() function
   */
  static async load(data) {
    const shieldData = JSON.parse(data);
    const shieldWorker = new Worker(
      new URL("worker_start.js", import.meta.url),
    );

    await new Promise((res) => {
      shieldWorker.onmessage = (msg) => {
        if (msg.data === "done") res();
      };
    });
    const pivxShield = new PIVXShield(
      shieldWorker,
      null,
      shieldData.extfvk,
      shieldData.isTestnet,
      shieldData.lastProcessedBlock,
      shieldData.commitmentTree,
    );
    pivxShield.diversifierIndex = shieldData.diversifierIndex;
    pivxShield.unspentNotes = shieldData.unspentNotes;
    return pivxShield;
  }

  /**
   * Loop through the txs of a block and update useful shield data
   * @param {{txs: string[], height: number}} blockJson - Json of the block outputted from any PIVX node
   */
  async handleBlock(blockJson) {
    if (this.#lastProcessedBlock > blockJson.height) {
      throw new Error(
        "Blocks must be processed in a monotonically increasing order!",
      );
    }
    for (const tx of blockJson.txs) {
      await this.#addTransaction(tx.hex);
      this.#pendingUnspentNotes.delete(tx.txid);
    }
    this.#lastProcessedBlock = blockJson.height;
  }
  /**
   * Adds a transaction to the tree. Decrypts notes and stores nullifiers
   * @param {string} hex - transaction hex
   */
  async #addTransaction(hex, decryptOnly = false) {
    const res = await this.#callWorker(
      "handle_transaction",
      this.#commitmentTree,
      hex,
      this.#extfvk,
      this.#isTestnet,
      this.#unspentNotes,
    );
    if (decryptOnly) {
      return res.decrypted_notes.filter(
        (note) =>
          !this.#unspentNotes.some(
            (note2) => JSON.stringify(note2[0]) === JSON.stringify(note[0]),
          ),
      );
    } else {
      this.#commitmentTree = res.commitment_tree;
      this.#unspentNotes = res.decrypted_notes;

      if (res.nullifiers.length > 0) {
        await this.#removeSpentNotes(res.nullifiers);
      }
    }
  }

  /**
   * Remove the Shield Notes that match the nullifiers given in input
   * @param {string[]} blockJson - Array of nullifiers
   */
  async #removeSpentNotes(nullifiers) {
    this.#unspentNotes = await this.#callWorker(
      "remove_spent_notes",
      this.#unspentNotes,
      nullifiers,
      this.#extfvk,
      this.#isTestnet,
    );
  }
  /**
   * @returns {number} number of shield satoshis of the account
   */
  getBalance() {
    return this.#unspentNotes.reduce((acc, [note]) => acc + note.value, 0);
  }

  /**
   * @returns {number} number of pending satoshis of the account
   */
  getPendingBalance() {
    return Array.from(this.#pendingUnspentNotes.values())
      .flat()
      .reduce((acc, v) => acc + v[0].value, 0);
  }

  /**
   * Creates a transaction, sending `amount` satoshis to the address
   * @param {{address: string, amount: number, blockHeight: number, useShieldInputs: boolean, utxos: UTXO[]?, transparentChangeAddress: string?}} target
   * @returns {{hex: string, spentUTXOs: UTXO[], txid: string}}
   */
  async createTransaction({
    address,
    amount,
    blockHeight,
    useShieldInputs = true,
    utxos,
    transparentChangeAddress,
  }) {
    if (!this.#extsk) {
      throw new Error("You cannot create a transaction in view only mode!");
    }
    if (!useShieldInputs && !transparentChangeAddress) {
      throw new Error("Change must have the same type of input used!");
    }
    const { txid, txhex, nullifiers } = await this.#callWorker(
      "create_transaction",
      {
        notes: useShieldInputs ? this.#unspentNotes : null,
        utxos: useShieldInputs ? null : utxos,
        extsk: this.#extsk,
        to_address: address,
        change_address: useShieldInputs
          ? await this.getNewAddress()
          : transparentChangeAddress,
        amount,
        block_height: blockHeight,
        is_testnet: this.#isTestnet,
      },
    );

    if (useShieldInputs) {
      this.#pendingSpentNotes.set(txid, nullifiers);
    }
    this.#pendingUnspentNotes.set(
      txid,
      await this.#addTransaction(txhex, true),
    );
    return {
      hex: txhex,
      spentUTXOs: useShieldInputs
        ? []
        : nullifiers.map((u) => {
            const [txid, vout] = u.split(",");
            return new UTXO({ txid, vout: Number.parseInt(vout) });
          }),
      txid,
    };
  }

  /**
   * @returns {Promise<number>} a number from 0.0 to 1.0 rapresenting
   * the progress of the transaction proof. If multicore is unavailable,
   * it always returns 0.0
   */
  async getTxStatus() {
    return await this.#callWorker("read_tx_progress");
  }
  /**
   * Signals the class that a transaction was sent successfully
   * and the notes can be marked as spent
   * @throws if txid is not found
   * @param{string} txid - Transaction id
   */
  async finalizeTransaction(txid) {
    const nullifiers = this.#pendingSpentNotes.get(txid);
    await this.#removeSpentNotes(nullifiers);
    this.#pendingSpentNotes.delete(txid);
  }
  /**
   * Discards the transaction, for example if
   * there were errors in sending them.
   * The notes won't be marked as spent.
   * @param {string} txid - Transaction id
   */
  discardTransaction(txid) {
    this.#pendingSpentNotes.delete(txid);
    this.#pendingUnspentNotes.delete(txid);
  }

  /**
   * @returns {Promise<string>} new shield address
   */
  async getNewAddress() {
    const { address, diversifier_index } = await this.#callWorker(
      "generate_next_shielding_payment_address",
      this.#extfvk,
      this.#diversifierIndex,
      this.#isTestnet,
    );
    this.#diversifierIndex = diversifier_index;
    return address;
  }

  /**
   * Load sapling prover. Must be done to create a transaction,
   * But will be done lazily if note called explicitally.
   * @returns {Promise<void>} resolves when the sapling prover is loaded
   */
  async loadSaplingProver() {
    return await this.#callWorker("load_prover");
  }

  /**
   * @returns {number} The last block that has been decoded
   */
  getLastSyncedBlock() {
    return this.#lastProcessedBlock;
  }
}

export class Note {
  /**
   * @type{number[]}
   */
  recipient;
  /**
   * @type{number[]}
   */
  value;
  /**
   * @type{number[]}
   */
  rseed;

  /**
   * Class corresponding to an unspent sapling shield note
   * @param {number[]} o.recipient - Recipient PaymentAddress encoded as a byte array
   * @param {number[]} o.value - How much PIVs are in the note
   * @param {number[]} o.rseed - Random seed encoded as a byte array
   */
  constructor({ recipient, value, rseed }) {
    this.recipient = recipient;
    this.value = value;
    this.rseed = rseed;
  }
}

export class UTXO {
  /**
   * Add a transparent UTXO, along with its private key
   * @param {object} o - Options
   * @param {string} o.txid - Transaction ID of the UTXO
   * @param {number} o.vout - output index of the UTXO
   * @param {number?} o.amount - Value in satoshi of the UTXO
   * @param {string?} o.privateKey - Private key associated to the UTXO
   * @param {Uint8Array?} o.script - Tx Script
   */
  constructor({ txid, vout, amount, privateKey, script }) {
    this.txid = txid;
    this.vout = vout;
    this.amount = amount;
    /**
     * @type {string}
     */
    this.private_key = privateKey ? bs58.decode(privateKey).slice(1, 33) : null;
    this.script = script;
  }
}

class ShieldData {
  /**
   * Add a transparent UTXO, along with its private key
   * @param {object} o - Options
   * @param {string} o.extfvk - Extended full viewing key
   * @param {number} o.lastProcessedBlock - Last processed block in blockchain
   * @param {string} o.commitmentTree - Hex encoded commitment tree
   * @param {Uint8Array} o.diversifierIndex - Diversifier index of the last generated address
   * @param {[Note, string][]} o.unspentNotes - Array of notes, corresponding witness
   * @param {boolean} o.isTestnet - If this is a testnet instance or not
   */
  constructor({
    extfvk,
    lastProcessedBlock,
    commitmentTree,
    diversifierIndex,
    unspentNotes,
    isTestnet,
  }) {
    this.extfvk = extfvk;
    this.diversifierIndex = diversifierIndex;
    this.lastProcessedBlock = lastProcessedBlock;
    this.commitmentTree = commitmentTree;
    this.unspentNotes = unspentNotes;
    this.isTestnet = isTestnet;
  }
}
