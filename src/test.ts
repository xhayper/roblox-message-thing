import { MessageServer } from ".";

const client = new MessageServer();

setInterval(function () {
    client.boardcast("Hello from NodeJS!");
}, 1000);

client.on("message", (_, message) => {
    console.log(message.message);
});

client.on("connect", (client) => {
    client.send("Hello! Client! Welcome!");
});

client.on("disconnect", (client) => {
    console.log(`Aww.. JobID: ${client.jobId} have disconnected!`);
});

client.listen({
    port: 3000
});
