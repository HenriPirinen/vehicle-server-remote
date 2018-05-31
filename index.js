var express = require('express');
var socket = require('socket.io');
var mqtt = require('mqtt');

var clientMQTT = mqtt.connect('mqtt://192.168.2.45'); //MQTT server address

clientMQTT.on('connect', function () {
	clientMQTT.subscribe('vehicleData');
	clientMQTT.subscribe('vehicleExternalCommand');
});


clientMQTT.on('message', function (topic, message) {
	console.log(message.toString())
	//clientMQTT.end()
});


var app = express();
var server = app.listen(4000, function () { //Start server
	console.log("Listening port 4000 @ localhost")
	console.log("MQTT is subscribed to 'vehicleData & vehicleExternalCommand'");
});

var io = socket(server);

io.on('connection', function (socket) {
	socket.emit('webSocket', {		//Send notification to new client 
		message: 'WebSocket connected!',
		handle: 'Server'
	});

	socket.on('command', function (data) { //Write command to arduino via USB

		switch (data.target) {
			case "controller_1":
                //TODO
				break;
			case "controller_2":
                //TODO
				break;
			case "inverter":
				//TODO
				console.log("Command to inverter");
				break;
			case "server":
				console.log("Command to server");
				break;
			default:
				console.log("Invalid target");
		}
	});
});

function validateJSON(string) { //Validate JSON string
	try {
		JSON.parse(string);
	} catch (e) {
		//console.log(e);
		return false;
	}
	return true;
}

var uploadData = () => {
	clientMQTT.publish('vehicleData', '{some_data}');
}

setInterval(uploadData, 5000);