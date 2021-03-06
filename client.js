var fs = require('fs');
var needle = require("needle");
// require config.json
var config = require('./config');
// connect us to the server with rcon
// IP, port, password
var Rcon = require('simple-rcon');
var client = new Rcon({
	host: config.clientIP,
	port: config.clientPort,
	password: config.clientPassword,
	timeout: 0
}).connect();

if (!fs.existsSync(config.factorioDirectory)){
    console.error("FATAL ERROR: config.factorioDirectory DOES NOT EXIST, PLEASE UPDATE CONFIG.JSON");
	process.exit(1);
}
// make sure we got the files we need
if (!fs.existsSync(config.factorioDirectory + "/script-output/")){
    fs.mkdirSync(config.factorioDirectory + "/script-output/");
}
if (!fs.existsSync(config.factorioDirectory + "/script-output/")){
	fs.writeFileSync(config.factorioDirectory + "/script-output/output.txt", "")
}
fs.writeFileSync(config.factorioDirectory + "/script-output/orders.txt", "")
fs.writeFileSync(config.factorioDirectory + "/script-output/txbuffer.txt", "");

client.on('authenticated', function() {
	console.log('Authenticated!');
}).on('connected', function() {
	console.log('Connected!');
}).on('disconnected', function() {
	console.log('Disconnected!');
	// now reconnect
	client.connect();
});

// set some globals
confirmedOrders = [];
lastSignalCheck = Date.now();
// provide items --------------------------------------------------------------
// trigger when something happens to output.txt
fs.watch(config.factorioDirectory + "/script-output/output.txt", function(eventType, filename) {
	// get array of lines in file
	items = fs.readFileSync(config.factorioDirectory + "/script-output/output.txt", "utf8").split("\n");
	// if you found anything, reset the file
	if(items[0]) {
		fs.writeFileSync(config.factorioDirectory + "/script-output/output.txt", "")
	}
	for(i = 0;i < items.length; i++) {
		if(items[i]) {
			g = items[i].split(" ");
			g[0] = g[0].replace("\u0000", "");
			console.log("exporting " + JSON.stringify(g));
			// send our entity and count to the master for him to keep track of
			needle.post(config.masterIP + ":" + config.masterPort + '/place', {name:g[0], count:g[1]}, 
			function(err, resp, body){
				// console.log(body);
			});
		}
	}
})
// request items --------------------------------------------------------------
setInterval(function() {
	// get array of lines in file
	items = fs.readFileSync(config.factorioDirectory + "/script-output/orders.txt", "utf8").split("\n");
	// if we actually got anything from the file, proceed and reset file
	if(items[0]) {
		fs.writeFileSync(config.factorioDirectory + "/script-output/orders.txt", "");
		// prepare a package of all our requested items in a more tranfer friendly format
		var preparedPackage = {};
		for(i = 0;i < items.length; i++) {
			(function(i){
				if(items[i]) {
					items[i] = items[i].split(" ");
					items[i][0] = items[i][0].replace("\u0000", "");
					items[i][0] = items[i][0].replace(",", "");
					if(preparedPackage[items[i][0]]){
						if(typeof Number(preparedPackage[items[i][0]].count) == "number" && typeof Number(items[i][1]) == "number") {
							preparedPackage[items[i][0]] = {"name":items[i][0], "count":Number(preparedPackage[items[i][0]].count) + Number(items[i][1])};
						} else if (typeof Number(items[i][1]) == "number") {
							preparedPackage[items[i][0]] = {"name":items[i][0], "count":Number(items[i][1])};
						}
					} else if (typeof Number(items[i][1]) == "number") {
						preparedPackage[items[i][0]] = {"name":items[i][0], "count":Number(items[i][1])};
					}
				}
			})(i);
		}
		// request our items, one item at a time
		for(i = 0;i<Object.keys(preparedPackage).length;i++){
			console.log(preparedPackage[Object.keys(preparedPackage)[i]])
			needle.post(config.masterIP + ":" + config.masterPort + '/remove', preparedPackage[Object.keys(preparedPackage)[i]], function(err, response, body){
				if(response && response.body && typeof response.body == "object") {
					// buffer confirmed orders
					confirmedOrders[confirmedOrders.length] = {[response.body.name]: response.body.count}
				}
			});
		}
		// if we got some confirmed orders
		console.log("Importing " + confirmedOrders.length + " items! " + JSON.stringify(confirmedOrders));
		sadas = JSON.stringify(confirmedOrders)
		confirmedOrders = [];
		// send our RCON command with whatever we got
		client.exec("/silent-command remote.call('clusterio', 'importMany', '" + sadas + "')");
	}
}, 3000)
// COMBINATOR SIGNALS ---------------------------------------------------------
// send any signals the slave has been told to send
setInterval(function() {
	// Fetch combinator signals from the server
	needle.post(config.masterIP + ":" + config.masterPort + '/readSignal', {since:lastSignalCheck}, function(err, response, body){
		if(response && response.body && typeof response.body == "object" && response.body[0]) {
			// Take the new combinator frames and compress them so we can use a single command
			frameset = [];
			for(i=0;i<response.body.length;i++) {
				frameset[i] = response.body[i].frame;
			}
			// console.log(frameset);
			// Send all our compressed frames
			client.exec("/silent-command remote.call('clusterio', 'receiveMany', '" + JSON.stringify(frameset) + "')");
		}
	});
	// after fetching all the latest frames, we take a timestamp. During the next iteration, we fetch all frames submitted after this.
	lastSignalCheck = Date.now();
	
	// get array of lines in file, each line should correspond to a JSON encoded frame
	signals = fs.readFileSync(config.factorioDirectory + "/script-output/txbuffer.txt", "utf8").split("\n");
	// if we actually got anything from the file, proceed and reset file
	if(signals[0]) {
		fs.writeFileSync(config.factorioDirectory + "/script-output/txbuffer.txt", "");
		// loop through all our frames
		for(i = 0;i < signals.length; i++) {
			(function(i){
				if(signals[i]) {
					// signals[i] is a JSON array called a "frame" of signals. We timestamp it for storage on master
					// then we unpack and RCON in this.frame to the game later.
					framepart = JSON.parse(signals[i])
					doneframe = {
						time: Date.now(),
						frame: framepart, // thats our array of objects(single signals)
					}
					// console.log(doneframe)
					needle.post(config.masterIP + ":" + config.masterPort + '/setSignal', doneframe, function(err, response, body){
						if(response && response.body) {
							// In the future we might be interested in whether or not we actually manage to send it, but honestly I don't care.
						}
					});
				}
			})(i);
		}
	}
}, 1000)