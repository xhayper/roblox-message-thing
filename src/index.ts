import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import TypedEmitter from "./types/typed-emitter";
import fastifyCaching from "@fastify/caching";
import { EventEmitter } from "node:events";
import { Type } from "@sinclair/typebox";
import { type Server } from "node:http";
import crypto from "node:crypto";
import fastify, {
    type FastifyReply,
    type FastifyRequest,
    type FastifyServerOptions,
    type FastifySchema,
    type FastifyBaseLogger,
    type FastifyListenOptions
} from "fastify";

interface Message {
    createdAt: Date | string;
    messageId: string;
    message: string;
}

class MessageClient {
    token: string;
    jobId: string;
    serverType: number;
    connectionTimeout: NodeJS.Timeout;
    pendingMessage: Record<
        string,
        {
            created: Date;
            message: string;
        }
    >;

    constructor(jobId: string, token: string, serverType: number) {
        this.jobId = jobId;
        this.token = token;
        this.serverType = serverType;
        this.connectionTimeout = setTimeout(() => {});
        this.pendingMessage = {};
    }

    send(message: string): string {
        const messageId = crypto.randomUUID();

        this.pendingMessage[messageId] = {
            created: new Date(),
            message: Buffer.from(message, "utf-8").toString("base64")
        };

        return messageId;
    }

    delete(messageId: string) {
        delete this.pendingMessage[messageId];
    }
}

const SessionHeaders: FastifySchema = {
    headers: Type.Object({
        jobid: Type.String(),
        token: Type.String()
    })
};

type MessageClientEvents = {
    connect: (client: MessageClient) => void;
    disconnect: (client: MessageClient) => void;
    message: (client: MessageClient, message: Message) => void;
};

export class MessageServer extends (EventEmitter as new () => TypedEmitter<MessageClientEvents>) {
    readonly connectedClient: Map<string, MessageClient> = new Map();
    readonly app = fastify().withTypeProvider<TypeBoxTypeProvider>();
    timeoutDuration: number;

    constructor(opts?: FastifyServerOptions<Server, FastifyBaseLogger> & { timeoutDuration?: number }) {
        super();

        this.timeoutDuration = opts?.timeoutDuration ?? 1000 * 5;

        this.app = fastify(opts).withTypeProvider<TypeBoxTypeProvider>();

        this.app.register(fastifyCaching, {
            privacy: fastifyCaching.privacy.NOCACHE
        });

        this.setupRoutes();
    }

    private validateClient(request: FastifyRequest, reply: FastifyReply): MessageClient | undefined {
        const { jobid, token } = request.headers;

        if (!jobid || !token) {
            reply.status(400).send({
                error: "Missing headers"
            });

            return;
        }

        if (!this.connectedClient.has(jobid.toString())) {
            reply.status(400).send({
                error: "Job ID does not exist"
            });

            return;
        }

        const client = this.connectedClient.get(jobid.toString())!;

        if (client.token !== token) {
            reply.status(400).send({
                error: "Invalid token"
            });
            return;
        }

        return client;
    }

    private setupRoutes() {
        this.app.post(
            "/connect",
            {
                schema: {
                    body: Type.Object({
                        jobId: Type.String(),
                        serverType: Type.Enum({
                            public: 0,
                            reserved: 1,
                            private: 2
                        })
                    })
                }
            },
            (request, reply) => {
                const { jobId, serverType } = request.body;

                if (this.connectedClient.has(jobId.toString())) {
                    return reply.status(400).send({
                        error: "Job ID already exists"
                    });
                }

                const token = crypto.randomBytes(32).toString("base64");

                const client: MessageClient = new MessageClient(jobId, token, serverType);

                client.connectionTimeout = setTimeout(() => {
                    this.connectedClient.delete(jobId.toString());
                    this.emit("disconnect", client);
                }, this.timeoutDuration);

                this.connectedClient.set(jobId.toString(), client);

                this.emit("connect", client);

                return reply.status(200).send({
                    token
                });
            }
        );

        this.app.get(
            "/ping",
            {
                schema: SessionHeaders
            },
            (request, reply) => {
                const client = this.validateClient(request, reply);
                if (!client) return;

                const { jobid } = request.headers;

                clearTimeout(client.connectionTimeout);
                client.connectionTimeout = setTimeout(() => {
                    this.connectedClient.delete(jobid!.toString());
                    this.emit("disconnect", client);
                }, this.timeoutDuration);

                return reply.status(200).send("OK");
            }
        );

        this.app.get(
            "/data",
            {
                schema: SessionHeaders
            },
            (request, reply) => {
                const client = this.validateClient(request, reply);
                if (!client) return;

                const pendingMessage = client.pendingMessage;

                const respond: Message[] = [];

                for (const [id, message] of Object.entries(pendingMessage)) {
                    respond.push({
                        createdAt:
                            typeof message.created === "string" ? message.created : message.created.toISOString(),
                        messageId: id,
                        message: message.message
                    });
                }

                return reply.status(200).send(respond);
            }
        );

        this.app.post(
            "/data",
            {
                schema: {
                    ...SessionHeaders,
                    body: Type.Array(
                        Type.Object({
                            createdAt: Type.String(),
                            messageId: Type.String(),
                            message: Type.String()
                        })
                    )
                }
            },
            async (request, reply) => {
                const client = this.validateClient(request, reply);
                if (!client) return;

                const messages = request.body;

                for (const message of messages) {
                    this.emit("message", client, {
                        ...message,
                        message: Buffer.from(message.message, "base64").toString("utf-8")
                    });
                }
            }
        );

        this.app.post(
            "/validation",
            {
                schema: {
                    ...SessionHeaders,
                    body: Type.Array(Type.String())
                }
            },
            (request, reply) => {
                const client = this.validateClient(request, reply);
                if (!client) return;

                const messages = request.body;

                for (const message of messages) {
                    delete client.pendingMessage[message];
                }

                return reply.status(200).send("OK");
            }
        );
    }

    boardcast(
        message: string,
        options: {
            excludePublic?: boolean;
            excludeReserved?: boolean;
            excludePrivate?: boolean;
        } = {}
    ) {
        for (const client of this.connectedClient.values()) {
            if (options.excludePublic && client.serverType === 0) continue;
            if (options.excludeReserved && client.serverType === 1) continue;
            if (options.excludePrivate && client.serverType === 2) continue;
            client.send(message);
        }
    }

    listen(opts?: FastifyListenOptions): Promise<string> {
        return this.app.listen(opts);
    }
}
