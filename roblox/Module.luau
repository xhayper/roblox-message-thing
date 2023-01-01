local HttpService = game:GetService("HttpService")

local base64 = require(script:WaitForChild("base64"))

local function getServerType(): number
	if game.PrivateServerId ~= "" then
		if game.PrivateServerOwnerId ~= 0 then
			return 2
		end
		return 1
	end
	return 0
end

local Client = {}
Client.__index = Client

export type ClientOptions = {
	Host: string?,
	Port: number?,
	PollingRate: number?
}

function Client.new(opts: ClientOptions?)
	opts = opts or {}
	local opt = opts :: ClientOptions
	opt.Host = opt.Host or "127.0.0.1"
	opt.Port = opt.Port or 3000
	opt.PollingRate = opt.PollingRate or 1

	local self = setmetatable({}, Client)

	self.Host = opt.Host
	self.Port = opt.Port
	self.PollingRate = opt.PollingRate
	
	self.Connected = false

	self.__messageBind = Instance.new("BindableEvent")
	self.OnMessage = self.__messageBind.Event

	self.__connectBind = Instance.new("BindableEvent")
	self.OnConnect = self.__connectBind.Event
	
	self.__disconnectBind = Instance.new("BindableEvent")
	self.OnDisconnect = self.__disconnectBind.Event

	self.__messageList = {}
	self.__validationList = {}
	self.__generatedJobId = HttpService:GenerateGUID(false)

	return self
end

function Client:__request(url, requestOptions: {
	Method: ("GET" | "POST" | "PATCH" | "DELETE")?,
	Headers: {[string]: string}?,
	Body: string?
	}?): {
	Success: boolean,
	StatusCode: number,
	StatusMessage: string,
	Headers: {[string]: string},
	Body: any
	}
	local opt = requestOptions or {}

	local Headers = opt.Headers or {}
	Headers.jobid = game.JobId == "" and self.__generatedJobId or game.JobId
	Headers.token = self.token

	return HttpService:RequestAsync({
		Url = ("http://%s:%s/%s" :: string):format(self.Host, self.Port, url),
		Method = opt.Method,
		Headers = Headers,
		Body = opt.Body
	})
end

function Client:SendMessage(message: string): string
	local id = HttpService:GenerateGUID(false)

	local encodedMessage = {
		createdAt = DateTime.now():ToIsoDate(),
		message = base64.encode(message),
		messageId = id
	}

	self.__messageList[id] = encodedMessage

	return id
end

function Client:Connect()
	local success, firstRespond = pcall(function()
		return self:__request("connect", {
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json"
			},
			Body = HttpService:JSONEncode({
				jobId = game.JobId == "" and self.__generatedJobId or game.JobId,
				serverType = getServerType()
			})
		})
	end)

	if not success or not firstRespond.Success then return end

	local data = HttpService:JSONDecode(firstRespond.Body)
	self.token = data.token

	task.spawn(function()
		repeat
			local success, respond = pcall(function()
				return self:__request("ping")
			end)
			if not success or not respond.Success then break end
			task.wait(self.PollingRate)
		until false
		
		if not self.Connected then return end

		self.Connected = false
		self.__messageList = {}
		self.__validationList = {}
		self.__disconnectBind:Fire()
	end)

	task.spawn(function()
		repeat
			local success, respond = pcall(function()
				return self:__request("data")
			end)
			if not success or not respond.Success then break end

			local messageList = HttpService:JSONDecode(respond.Body)

			local messageIdList = {}

			for _, message in ipairs(messageList) do
				local parsedMessage = {
					createdAt = DateTime.fromIsoDate(message.createdAt),
					message = base64.decode(message.message),
					messageId = message.messageId
				}

				self.__messageBind:Fire(parsedMessage)

				table.insert(messageIdList, message.messageId)
			end

			local success, result = pcall(function()
				return self:__request("validation", {
					Method = "POST",
					Headers = {
						["Content-Type"] = "application/json"
					},
					Body = HttpService:JSONEncode(messageIdList)
				})
			end)
			
			if not success or not result.Success then break end

			task.wait(self.PollingRate)
		until false
		
		if not self.Connected then return end
		
		self.Connected = false
		self.__messageList = {}
		self.__validationList = {}
		self.__disconnectBind:Fire()
	end)

	task.spawn(function()
		repeat
			local messgeList = {}
			local idList = {}

			for id, message in pairs(self.__messageList) do
				table.insert(messgeList, message)
				table.insert(idList, id)
			end

			if #messgeList > 0 then
				local success, respond = pcall(function()
					return self:__request("data", {
						Method = "POST",
						Headers = {
							["Content-Type"] = "application/json"
						},
						Body = HttpService:JSONEncode(messgeList)
					})
				end)

				if not success or not respond.Success then break end
				
				for _, id in ipairs(idList) do
					self.__messageList[id] = nil
				end
			end

			task.wait(self.PollingRate)
		until false
		
		if not self.Connected then return end

		self.Connected = false
		self.__messageList = {}
		self.__validationList = {}
		self.__disconnectBind:Fire()
	end)
	

	self.Connected = true
	self.__connectBind:Fire()
end

return Client