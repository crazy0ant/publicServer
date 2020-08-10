const config = require('./config');
const protoo = require('protoo-server');
const { AwaitQueue } = require('awaitqueue');
const fs = require('fs');
const https = require('https');
const http = require('http');
const url = require('url');
const Room = require('./lib/Room');

// Async queue to manage rooms.
// @type {AwaitQueue}
const queue = new AwaitQueue();


// Map of Room instances indexed by roomId.
// @type {Map<Number, Room>}
const rooms = new Map();


// Protoo WebSocket server.
// @type {protoo.WebSocketServer}
let protooWebSocketServer;

// HTTPS server.
// @type {https.Server}
let httpsServer;

// HTTP server.
// @type {https.Server}
let httpServer;
run();
async function run()
{

    // Run HTTP server.
    //await runHttpServer();
    await runHttpServer();

    // Run HTTPS server.
    //await runHttpsServer();
    //await runHttpsServer();

    // Run a protoo WebSocketServer.
    await runProtooWebSocketServer();

    // Run a protoo WebSocketServer2.
    //await runProtooWebSocketServer2();

    // Log rooms status every X seconds.
    /*setInterval(() =>
    {
        for (const room of rooms.values())
        {
            room.logStatus();
        }
    }, 5000);*/
}

async function runHttpServer()
{
    //logger.info('running an HTTP server...');

    // HTTP server for the protoo WebSocket server.


    httpServer = http.createServer();

    await new Promise((resolve) =>
    {
        httpServer.listen(Number(config.http.listenPort), config.http.listenIp, resolve);
        console.log('httpsPort',config.http.listenPort);
    });
}


/**
 * Create a protoo WebSocketServer to allow WebSocket connections from browsers.
 */
async function runProtooWebSocketServer()
{
    // Create the protoo WebSocket server.
    protooWebSocketServer = new protoo.WebSocketServer(httpServer,
        {
            maxReceivedFrameSize     : 960000, // 960 KBytes.
            maxReceivedMessageSize   : 960000,
            fragmentOutgoingMessages : true,
            fragmentationThreshold   : 960000
        });

    // Handle connections from clients.
    protooWebSocketServer.on('connectionrequest', (info, accept, reject) =>
    {
        // The client indicates the roomId and peerId in the URL query.
        const u = url.parse(info.request.url, true);
        const roomId = u.query['roomId'];
        const peerId = u.query['peerId'];


        if (!roomId || !peerId)
        {
            reject(400, 'Connection request without roomId and/or peerId');

            return;
        }


        // Serialize this code into the queue to avoid that two peers connecting at
        // the same time with the same roomId create two separate rooms with same
        // roomId.
        queue.push(async () =>
        {
            const room = await getOrCreateRoom({ roomId });

            // Accept the protoo WebSocket connection.
            const protooWebSocketTransport = accept();

            room.handleProtooConnection({ peerId, protooWebSocketTransport });
        })
            .catch((error) =>
            {
                logger.error('room creation or room joining failed:%o', error);

                reject(error);
            });
    });
}


/**
 * Get a Room instance (or create one if it does not exist).
 */
async function getOrCreateRoom({ roomId })
{
    let room = rooms.get(roomId);

    // If the Room does not exist create a new one.
    if (!room)
    {
        room = await Room.create({ roomId });

        rooms.set(roomId, room);
        room.on('close', () => rooms.delete(roomId));
    }

    return room;
}