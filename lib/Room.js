const EventEmitter = require('events').EventEmitter;
const protoo = require('protoo-server');
const throttle = require('@sitespeed.io/throttle');

const config = require('../config');



/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter
{

	static async create({ roomId})
	{

		// Create a protoo Room instance.
		const protooRoom = new protoo.Room();

		return new Room(
			{
				roomId,
				protooRoom,
			});
	}

	logStatus(){
		const time = new Date().getTime();
		console.log('**********************'+time+'*************************');
		console.log('roomId',this._roomId);
		for(const peer of this._protooRoom.peers){
			console.log('displayName:',peer._data.displayName);
			console.log('isMaster',peer._data.isMaster);
			console.log('------------');
		}


	}
	constructor({ roomId, protooRoom })
	{
		super();
		// Room id.
		// @type {String}
		this._roomId = roomId;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// protoo Room instance.
		// @type {protoo.Room}
		this._protooRoom = protooRoom;


		// Network throttled.
		// @type {Boolean}
		this._networkThrottled = false;

	}

	/**
	 * Closes the Room instance by closing the protoo Room and the mediasoup Router.
	 */
	close()
	{

		this._closed = true;

		// Close the protoo Room.
		this._protooRoom.close();

		// Emit 'close' event.
		this.emit('close');

		// Stop network throttling.
		if (this._networkThrottled)
		{
			throttle.stop({})
				.catch(() => {});
		}
	}



	/**
	 * Called from server.js upon a protoo WebSocket connection request from a
	 * browser.
	 *
	 * @param {String} peerId - The id of the protoo peer to be created.
	 * @param {Boolean} consume - Whether this peer wants to consume from others.
	 * @param {protoo.WebSocketTransport} protooWebSocketTransport - The associated
	 *   protoo WebSocket transport.
	 */
	handleProtooConnection({ peerId,isMaster, protooWebSocketTransport })
	{
		const existingPeer = this._protooRoom.getPeer(peerId);

		if (existingPeer)
		{
			console.log('handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]');
			existingPeer.close();
		}

		let peer;

		// Create a new protoo Peer with the given peerId.
		try
		{
			peer = this._protooRoom.createPeer(peerId, protooWebSocketTransport);
		}
		catch (error)
		{
			//logger.error('protooRoom.createPeer() failed:%o', error);
		}

		// Use the peer.data object to store mediasoup related objects.

		// Not joined after a custom protoo 'join' request is later received.

		peer.data.joined = false;
		peer.data.displayName = undefined;
		peer.data.device = undefined;
		peer.data.isMaster = false;


		peer.on('request', (request, accept, reject) =>
		{
			/*logger.debug(
				'protoo Peer "request" event [method:%s, peerId:%s]',
				request.method, peer.id);*/

			this._handleProtooRequest(peer, request, accept, reject)
				.catch((error) =>
				{
					reject(error);
				});
		});

		peer.on('close', () =>
		{
			if (this._closed)
				return;
			// If the Peer was joined, notify all Peers.
			if (peer.data.joined)
			{
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify('peerClosed', { peerId: peer.id })
						.catch(() => {});
				}
			}

			// If this is the latest Peer in the room, close the room.
			if (this._protooRoom.peers.length === 0)
			{
				this.close();
			}
		});
	}



	/**
	 * Handle protoo requests from browsers.
	 *
	 * @async
	 */
	async _handleProtooRequest(peer, request, accept, reject)
	{
		console.log('收到request',request);
		switch (request.method)
		{

			case 'masterJoin':
			{
				// Ensure the Peer is not already joined.
				if (peer.data.joined)
					throw new Error('Peer already joined');

				const {
					displayName,
					isMaster
				} = request.data;
				//判断master是否已经加入房间
				const joinedPeers = [ ...this._getJoinedPeers(), ];
				const masterPeer = joinedPeers.filter((joinedPeer)=>joinedPeer.data.isMaster==true);
				if(masterPeer.length>0){
					//throw new Error('房间内已存在采集端');
					accept({ err: '房间内已存在采集端' });
					break;
				}
				// Store client data into the protoo Peer data object.
				peer.data.joined = true;
				peer.data.displayName = displayName;
				peer.data.isMaster = isMaster;

				// Tell the new Peer about already joined Peers.
				//const joinedPeers = [ ...this._getJoinedPeers(), ];

				// Reply now the request with the list of joined peers (all but the new one).
				const peerInfos = joinedPeers
					.filter((joinedPeer) => joinedPeer.id !== peer.id)
					.map((joinedPeer) => ({
						id          : joinedPeer.id,
						displayName : joinedPeer.data.displayName,
						isMaster    : joinedPeer.data.isMaster
					}));
				accept({ peers: peerInfos });
				break;
			}
			case 'join':
			{
				// Ensure the Peer is not already joined.
				if (peer.data.joined)
					throw new Error('Peer already joined');

				const {
					displayName,
					isMaster
				} = request.data;
				// Store client data into the protoo Peer data object.
				peer.data.joined = true;
				peer.data.displayName = displayName;
				peer.data.isMaster = isMaster;

				// Tell the new Peer about already joined Peers.
				const joinedPeers = [ ...this._getJoinedPeers(), ];

				// Reply now the request with the list of joined peers (all but the new one).
				const peerInfos = joinedPeers
					.filter((joinedPeer) => joinedPeer.id !== peer.id)
					.map((joinedPeer) => ({
						id          : joinedPeer.id,
						displayName : joinedPeer.data.displayName,
						isMaster    : joinedPeer.data.isMaster
					}));
				accept({ peers: peerInfos });

				// Notify the new Peer to all other Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'newPeer',
						{
							id          : peer.id,
							displayName : peer.data.displayName,
							isMaster    : peer.data.isMaster
						})
						.catch(() => {});
				}
				break;
			}

			case 'forwardToOne':
			{
				if (!peer.data.joined) throw new Error('Peer not yet joined');
				const { peerId, message } = request.data;
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					if(peerId==otherPeer._data.displayName){

						otherPeer.notify(
							'forwardToOne',
							{
								peerId: peer._data.displayName,
								message: message,
							})
							.catch(() => {});
					}

				}
				accept();
				break;
			}

			case 'forwardMsg' :
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');
				const { textData } = request.data;
				// Notify other joined Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'forwardMsg',
						{
							peerId : peer.id,
							textData: textData
						})
						.catch(() => {});
				}
				accept();
				break;
			}

			case 'changeDisplayName':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { displayName } = request.data;
				const oldDisplayName = peer.data.displayName;

				// Store the display name into the custom data Object of the protoo
				// Peer.
				peer.data.displayName = displayName;

				// Notify other joined Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'peerDisplayNameChanged',
						{
							peerId : peer.id,
							displayName,
							oldDisplayName
						})
						.catch(() => {});
				}
				accept();
				break;
			}

			default:
			{
				//logger.error('unknown request.method "%s"', request.method);

				reject(500, `unknown request.method "${request.method}"`);
			}
		}
	}

	/**
	 * Helper to get the list of joined protoo peers.
	 */
	_getJoinedPeers({ excludePeer = undefined } = {})
	{
		return this._protooRoom.peers
			.filter((peer) => peer.data.joined && peer !== excludePeer);
	}

}

module.exports = Room;
