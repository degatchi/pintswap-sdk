import { protocol } from "./protocol";
import { PintP2P } from "./p2p";
import { ethers } from "ethers";
import { pipe } from "it-pipe";
import * as lp from "it-length-prefixed";
import { TPCEcdsaKeyGen as TPC, TPCEcdsaSign as TPCsign } from "@safeheron/two-party-ecdsa-js";
import { emasm } from "emasm";
import { EventEmitter } from "events";
import pushable from "it-pushable";
import BN from "bn.js";
import { 
  keyshareToAddress,
  createContract,
  hashOffer,
  leftZeroPad,
  toBigInt
} from "./trade";
import { type IOffer } from "./types";

const {
  solidityPackedKeccak256,
  hexlify,
  getAddress,
  getCreateAddress,
  VoidSigner,
  Contract,
  Transaction,
} = ethers;

export class Pintswap extends PintP2P {
  public signer: any;
  public offers: Map<string, IOffer> = new Map();


  static async initialize({ signer }) {
    let peerId = await this.peerIdFromSeed(await signer.getAddress());
    return new this({ signer, peerId });
  }

  constructor({ signer, peerId }) {
    super({ signer, peerId });
    this.signer = signer;
  }

  async startNode() {
    await this.start();
    await this.handleBroadcastedOffers();
    this.emit(`Pintswap:: started libp2p`);
  }

  async stopNode() {
    await this.stop();
    this.emit(`Pintswap:: stopped libp2p`);
  }

  async handleBroadcastedOffers() {
    await this.handle("/pintswap/0.1.0/orders", (duplex) =>
      pipe(
        duplex.stream.sink,
        lp.encode(),
        protocol.OfferList.encode({ offers: this.offers.values() })
      )
    );

    await this.handle(
      "/pintswap/0.1.0/create-trade",
      async ({ stream, connection, protocol }) => {
          let context2 = await TPC.P2Context.createContext();
          let messages = pushable();
          let _event = new EventEmitter();
          let sharedAddress = null;
          let keyshareJson = null;
          let signContext = null;
          

          _event.on('/event/ecdsa-keygen/party/2', (step, message) => {
            switch(step) {
              case 1:
                console.log(
                  `MAKER:: /event/ecdsa-keygen/party/2 handling message: ${step}`
                )
                messages.push(
                  context2.step1(message)
                )
                break;
              case 3:
                console.log(
                  `MAKER:: /event/ecdsa-keygen/party/2 handling message: ${step}`
                )
                context2.step2(message)
                // set keyshare and shared address
                keyshareJson = context2.exportKeyShare().toJsonObject();
                sharedAddress = keyshareToAddress(keyshareJson);
                break;
              default:
                throw new Error("Unexpected message on event /ecdsa-keygen/party/2");
                break;
            }
          });

          _event.on('/event/approve-contract', async ( offerHashBuf ) => {
            try {
              let offer = this.offers.get(offerHashBuf.toString());
              await this.approveTradeAsMaker(offer, sharedAddress as string);
            } catch (err) {
              throw new Error("couldn't find offering");
            }
            console.log(
              `MAKER:: /event/approve-contract approved offer with offer hash: ${ offerHashBuf.toString() }`
            );
          });

          _event.on('/event/ecdsa-sign/party/2/init', async ( unsignedTxHash ) => {
            console.log(
              `MAKER:: /event/ecdsa-sign/party/2/init received unsigned hash: ${ unsignedTxHash.toString() }`
            );
            signContext = await TPCsign.P2Context.createContext(
              JSON.stringify(keyshareJson, null, 4),
              new BN(unsignedTxHash.toString(), 16)
            )
          });

          _event.on('/event/ecdsa-sign/party/2', (step, message) => {
            switch(step) {
              case 1:
                console.log(`MAKER:: /event/ecdsa-sign/party/2 handling message: ${step}`)
                messages.push(
                  signContext.step1(message)
                )
                break;
              case 3:
                console.log(`MAKER:: /event/ecdsa-sign/party/2 handling message ${step}`)
                messages.push(
                  signContext.step2(message)
                )
                messages.end()
                break;
                // safe to end message iterator
              default:
                throw new Error("Unexpeced message on event /ecdsa-sign/party/2");
                break;
            }
          })


          pipe(
            stream.source,
            lp.decode(),
            async function (source) {
              const { value: keygenMessage1 } = await source.next();
              _event.emit('/event/ecdsa-keygen/party/2', 1, keygenMessage1.slice());
              const { value: keygenMessage3 } = await source.next();
              _event.emit('/event/ecdsa-keygen/party/2', 3, keygenMessage3.slice());

              const { value: offerHashBuf } = await source.next(); 
              _event.emit('/event/approve-contract', offerHashBuf.slice())

              const { value: unsignedTxHash } = await source.next();
              _event.emit('/event/ecdsa-sign/party/2/init', unsignedTxHash.slice())

              const { value: signMessage1 } = await source.next();
              _event.emit('/event/ecdsa-sign/party/2', 1, signMessage1.slice())
              const { value: signMessage3 } = await source.next();
              _event.emit('/event/ecdsa-sign/party/2', 3, signMessage3.slice())

            }
          )

          await pipe(
            messages,
            lp.encode(),
            stream.sink
          )
      },
    );
  }


  // adds new offer to this.offers: Map<hash, IOffer>
  listOffer(_offer: IOffer) {
      console.log('trying to list new offer');
      this.offers.set(hashOffer(_offer), _offer);
  }

  async getTradeAddress(sharedAddress: string) {
    
    const address = getCreateAddress({
      nonce: await this.signer.provider.getTransactionCount(sharedAddress), 
      from: sharedAddress, 
    });
    console.log('TRADE ADDRESS: ' + address);
    return address;
  }
  async approveTradeAsMaker(offer: IOffer, sharedAddress: string) {
    const tradeAddress = await this.getTradeAddress(sharedAddress);
    const token = new Contract(
      offer.givesToken,
      ["function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"],
      this.signer
    )
    const tx = await token.approve(tradeAddress, offer.givesAmount);
    console.log('MAKER BALANCE ' + ethers.formatEther(await token.balanceOf(await this.signer.getAddress())));
    console.log('MAKER APPROVED BALANCE ' + ethers.formatEther(await token.allowance(await this.signer.getAddress(), tradeAddress)));
    return tx;
  }
  async approveTradeAsTaker(offer: IOffer, sharedAddress: string) {
    const tradeAddress = await this.getTradeAddress(sharedAddress);
    const token = new Contract(
      getAddress(offer.getsToken),
      ["function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"],
      this.signer
    );
    const tx = await token.approve(tradeAddress, offer.getsAmount);
    console.log('TAKER BALANCE ' + ethers.formatEther(await token.balanceOf(await this.signer.getAddress())));
    console.log('TAKER APPROVED BALANCE ' + ethers.formatEther(await token.allowance(await this.signer.getAddress(), tradeAddress)));
    return tx;

  }
  async createTransaction(offer: IOffer, maker: string, sharedAddress: string) {
    console.log(
      `/internal/creating a new transaction`
    )
    const contract = createContract(
      offer,
      maker,
      await this.signer.getAddress()
    );
    const gasPrice = toBigInt(await this.signer.provider.getGasPrice());

    const gasLimit = toBigInt(await this.signer.provider.estimateGas({
      data: contract,
      from: sharedAddress,
      gasPrice,
    }));
      
    let sharedAddressBalance = toBigInt(await this.signer.provider.getBalance(sharedAddress));
    console.log(
      `network ${ (await this.signer.provider.getNetwork()).chainId }`,
      sharedAddressBalance,
      gasPrice,
      gasLimit
    )
    return Object.assign(new Transaction(), {
      data: createContract(offer, maker, await this.signer.getAddress()),
      chainId: (await this.signer.provider.getNetwork()).chainId,
      gasPrice,
      gasLimit,
      nonce: await this.signer.provider.getTransactionCount(sharedAddress),
      value: sharedAddressBalance >= ( gasPrice * gasLimit ) ? (sharedAddressBalance) - ( gasPrice * gasLimit ) : BigInt(0), // check: balance >= ( gasPrice * gasLimit ) | resolves ( balance - (gasPrice * gasLimit) ) or 0
    });
  }

  async createTrade(peer, offer) {
    console.log( 
      `Acting on offer ${ offer } with peer ${ peer }`
    );
  
    let { stream } = await this.dialProtocol(peer, [
      "/pintswap/0.1.0/create-trade",
    ]);

    let _event = new EventEmitter();
    let context1 = await TPC.P1Context.createContext();
    let signContext = null;
    const message1 = context1.step1(); 
    const messages = pushable(); 
    let tx = null;
    let sharedAddress = null;
    let keyshareJson = null;

    _event.on('/event/ecdsa-keygen/party/1', (step, message) => {
      switch(step) {
        case 2:
          console.log(
            `TAKER:: /event/ecdsa-keygen/party/1 handling message: ${step}`
          )

          messages.push(
            context1.step2(message)
          )
          keyshareJson = context1.exportKeyShare().toJsonObject();
          sharedAddress = keyshareToAddress(keyshareJson);
          break;
        default:
          throw new Error("unexpected message on event /ecdsa-keygen/party/1");
          break;
      }
    })

    /*
     * Pintswap#approveAsMaker
     */
    _event.on('/event/approve-contract', async () => {
      // approve as maker
      console.log(
        `TAKER:: /event/approve-contract approving offer: ${offer} of shared Address ${ sharedAddress }`
      );
      messages.push(
        Buffer.from(hashOffer(offer)) 
      )
      await this.approveTradeAsTaker(offer, sharedAddress as string);
    });

    _event.on('/event/build/tx', async () => {

      console.log(
        `/event/build/tx funding sharedAddress ${ sharedAddress }`
      );
      await this.signer.sendTransaction({
        to: sharedAddress,
        value: ethers.parseEther("0.02") // change to gasPrice * gasLimit
      });


      console.log(
        `TAKER:: /event/build/tx building transaction with params: ${offer}, ${await this.signer.getAddress()}, ${ sharedAddress }`
      );
      tx = await this.createTransaction(
        offer,
        await this.signer.getAddress(),
        sharedAddress as string
      )
      console.log(
        `TAKER:: /event/build/tx built transaction`
      )

      let _uhash = (tx.unsignedHash as string).slice(2);
      signContext = await TPCsign.P1Context.createContext(
        JSON.stringify(keyshareJson, null, 4),
        new BN(_uhash, 16)
      )

      console.log(
        `TAKER:: /event/build/tx sending unsigned transaction hash & signing step 1`
      );

      messages.push(
        Buffer.from(_uhash)
      )
      messages.push(
        signContext.step1()
      )
    })

    _event.on('/event/ecdsa-sign/party/1', async (step, message) => {
      switch(step) {
        case 2:
          console.log(`TAKER:: /event/ecdsa-sign/party/1 handling message ${step}`)
          messages.push(
            signContext.step2(message)
          )
          break;
        case 4:
          console.log(`TAKER:: /event/ecdsa-sign/party/1 handling message ${step}`)
          signContext.step3(message);
          let [r, s, v] = signContext.exportSig();
          tx.signature = ethers.Signature.from({
            r: '0x' + r.toString(16),
            s: '0x' + s.toString(16),
            v: v + 27
          })
          let txReceipt = typeof this.signer.provider.sendTransaction == 'function' ? await this.signer.provider.sendTransaction(tx.serialized) : await this.signer.provider.broadcastTransaction(tx.serialized);
          console.log(await txReceipt.wait());
          messages.end()
          stream.close();
          break;
        default:
          throw new Error("Unexpeced message on event /ecdsa-sign/party/2");
          break;
      }
    })

    let result = pipe(
      stream.source,
      lp.decode(),
      async function (source) {
        messages.push(message1);
        const { value: keygenMessage_2} = await source.next();
        _event.emit('/event/ecdsa-keygen/party/1', 2, keygenMessage_2.slice());
        _event.emit('/event/approve-contract');
        _event.emit('/event/build/tx');
        const { value: signMessage_2 } = await source.next();
        _event.emit('/event/ecdsa-sign/party/1', 2, signMessage_2.slice())
        const { value: signMessage_4 } = await source.next();
        _event.emit('/event/ecdsa-sign/party/1', 4, signMessage_4.slice());
      }
    )

    await pipe(
      messages,
      lp.encode(),
      stream.sink
    )

    return true 

  }

}
