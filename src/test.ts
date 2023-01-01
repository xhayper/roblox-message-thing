import { MessageServer } from ".";

const server = new MessageServer();

setInterval(function () {
    server.boardcast("Hello from NodeJS!");
}, 1000);

server.on("message", (_, message) => {
    console.log(message.message);
});

server.on("connect", (client) => {
    client.send(`Hello! JobId: ${client.jobId}! Welcome!`);
});

server.on("disconnect", (client) => {
    console.log(`Aww.. JobId: ${client.jobId} have disconnected!`);
});

server.listen({
    port: 3000
});
