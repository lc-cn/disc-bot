import {EventEmitter} from 'events'
import FormData from 'form-data'
import * as fs from 'fs'
import {HttpsProxyAgent} from 'https-proxy-agent'
import {RawData, WebSocket, WebSocketServer} from 'ws';
import axios, {AxiosInstance, CreateAxiosDefaults} from 'axios'
import {SessionManager} from '@/sessionManager';
import {Dict, LogLevel} from "@/types";
import {Intends} from "@/constans";
import {OriginEvent} from "@/event";
import {DirectMessageEvent, GuildMessageEvent, Message} from "@/message";
import {Quotable, Sendable} from "@/elements";
import {Sender} from "@/entries/sender";
import {getLogger, Logger} from "log4js";
import {createServer,Server} from "http";
import {IncomingMessage, ServerResponse} from "node:http";
import * as querystring from "querystring";
import {getArgs} from "@/utils";

export class Bot extends EventEmitter {
    self_id=""
    nickname=""
    status=0;
    request: AxiosInstance
    ws?: WebSocket
    sessionManager: SessionManager
    logger:Logger
    server:Server
    wss:WebSocketServer
    constructor(public options: Bot.Options) {
        super();
        this.logger=getLogger(`[Discord]`)
        this.logger.level=options.log_level||'info';
        this.server=createServer(this.requestHandler.bind(this))
        this.wss=new WebSocketServer({server:this.server})
        this.wss.on('connection',(client)=>{
            const handleMsg=this.handleWs.bind(this,client)
            client.on('message',handleMsg)
            client.on('close',()=>{
                this.logger.info('ws client closed')
            })
        })
        this.options.ignore_self=this.options.ignore_self||true;
        const config:CreateAxiosDefaults={
            proxy:false,
            baseURL: 'https://discord.com/api',
        }
        if(this.options.proxy){
            config.httpsAgent=new HttpsProxyAgent(
                `http://${this.options.proxy.host}:${this.options.proxy.port}`
            )
        }
        this.request = axios.create(config)
        this.sessionManager = new SessionManager(this)
        this.request.interceptors.request.use((config) => {
            config.headers.set('Authorization', `Bot ${this.sessionManager.token}`)
            config.headers.set('User-Agent',`DiscordBot (${config.url}, 10)`)
            return config
        })
    }
    async requestHandler(req:IncomingMessage,res:ServerResponse){
        const {url}=req;
        if(url==='/') return res.writeHead(200).end('Discord Bot')
        const queryParam=querystring.parse(req.url)
        const {method,headers}=req
        if(method==='POST' && headers['content-type']==='application/x-www-form-urlencoded'){
            const body=querystring.parse(req['body'] as string)
            if(this.options.access_token &&
                !body.access_token?.includes(this.options.access_token) &&
                !queryParam.access_token?.includes(this.options.access_token)){
                return res.writeHead(401).end('Unauthorized')
            }
            const {action=queryParam.action,params=queryParam.params}=body
            try{
                const result=await this.applyMethod(req,action as string,params as Dict)
                res.writeHead(200).end(result)
            }catch(e){
                this.logger.error(e)
                res.writeHead(500).end(`Internal Server Error`)
            }
        }
        if(this.options.access_token && queryParam.access_token!==this.options.access_token)
            return res.writeHead(401).end('Unauthorized')
        return this.applyMethod(req,queryParam.action as string,queryParam.params as Dict)
    }
    async handleWs(client:WebSocket,message:RawData){
        try{
            const payload=JSON.parse(message.toString())
            const {action,params,echo}=payload
            if(action){
                const result=await this.applyMethod(client,action as string,params as Dict)
                return client.send(JSON.stringify({
                    type: 'action_result',
                    echo,
                    data:{
                      action,
                      result,
                    },
                }))
            }
        }catch(e){
            this.logger.error(e)
            client.send(JSON.stringify({
                type: 'server.error',
                data: e.message,
            }))
        }
    }
    sendWsMsg(event:DirectMessageEvent|GuildMessageEvent){
        if(this.options.ignore_self && event.user_id===this.self_id) return
        const msg=JSON.stringify({
            type: 'event',
            data: event,
        })
        for(const client of this.wss.clients){
            client.send(msg)
        }
    }
    async applyMethod<T extends IncomingMessage|WebSocket>(source:T,action:string,params:Dict){
        const fn=this[action]
        if(!fn ||typeof fn!=='function') return fn
        return await fn(...getArgs(fn,params))
    }
    dispatchEvent(event: string, wsRes: any) {
        const payload = wsRes.d;
        const event_id = wsRes.id || '';
        if (!payload || !event) return;
        const transformEvent = OriginEvent[event] || 'system'
        const eventPayload=this.processPayload(event_id, transformEvent, payload)
        if(eventPayload.user_id===this.self_id && this.options.ignore_self) return;
        this.em(transformEvent, eventPayload);
    }
    processPayload(event_id: string, event: string, payload: Dict) {
        let [post_type, ...sub_type] = event.split('.')
        const result: Dict = {
            event_id,
            post_type,
            [`${post_type}_type`]: sub_type.join('.'),
            ...payload
        }
        if (['message.group', 'message.private', 'message.guild', 'message.direct'].includes(event)) {
            const [message, brief] = Message.parse.call(this, payload)
            result.message = message as Sendable
            const member = payload.member
            const permissions = member?.roles || []
            Object.assign(result, {
                user_id: payload.author?.id,
                id:payload.event_id||payload.id,
                message_id: payload.event_id || payload.id,
                raw_message: brief,
                sender: {
                    user_id: payload.author?.id,
                    user_name: payload.author?.username,
                    permissions: ['normal'].concat(permissions),
                    user_openid: payload.author?.user_openid || payload.author?.member_openid
                },
                timestamp: new Date(payload.timestamp).getTime() / 1000,
            })
            let messageEvent: GuildMessageEvent | DirectMessageEvent
            switch (event) {
                case 'message.guild':
                    messageEvent = new GuildMessageEvent(this as unknown as Bot, result)
                    this.sendWsMsg(messageEvent)
                    this.logger.info(`recv Guild(${result.guild_id})Channel(${result.channel_id}): ${result.raw_message}`)
                    break;
                case 'message.direct':
                    messageEvent = new DirectMessageEvent(this as unknown as Bot, result)
                    this.sendWsMsg(messageEvent)
                    this.logger.info(`recv Direct(${result.guild_id}): ${result.raw_message}`)
                    break;
            }
            return messageEvent
        }
        return result
    }
    em(event: string, payload: Dict) {
        const eventNames = event.split('.')
        const [post_type, detail_type, ...sub_type] = eventNames
        Object.assign(payload, {
            post_type,
            [`${post_type}_type`]: detail_type,
            sub_type: sub_type.join('.'),
            ...payload
        })
        let prefix = ''
        while (eventNames.length) {
            let fullEventName = `${prefix}.${eventNames.shift()}`
            if (fullEventName.startsWith('.')) fullEventName = fullEventName.slice(1)
            this.emit(fullEventName, payload)
            prefix = fullEventName
        }
    }
    async getGuildList() {
        const _getGuildList = async (after: string = undefined) => {
            const res = await this.request.get('/users/@me/guilds', {
                params: {
                    after
                }
            }).catch(() => ({data: []}))// 私域不支持获取频道列表，做个兼容
            if (!res.data?.length) return []
            const result = (res.data || []).map(g => {
                const {id: guild_id, name: guild_name, joined_at, ...guild} = g
                return {
                    guild_id,
                    guild_name,
                    join_time: new Date(joined_at).getTime() / 1000,
                    ...guild
                }
            })
            const last = result[result.length - 1]
            return [...result, ...await _getGuildList(last.guild_id)]
        }
        return await _getGuildList()
    }

    async getGuildMemberList(guild_id: string) {
        const _getGuildMemberList = async (after: string = undefined) => {
            const res = await this.request.get(`/users/@me/guilds/${guild_id}/members`, {
                params: {
                    after,
                    limit: 100
                }
            }).catch(() => ({data: []}))// 公域没有权限，做个兼容
            if (!res.data?.length) return []
            const result = (res.data || []).map(m => {
                const {id: member_id, name: member_name, role, join_time, ...member} = m
                return {
                    member_id,
                    member_name,
                    role,
                    join_time: new Date(join_time).getTime() / 1000,
                    ...member
                }
            })
            const last = result[result.length - 1]
            return [...result, ...await _getGuildMemberList(last.member_id)]
        }
        return await _getGuildMemberList()
    }
    async uploadMedia(file: string) {
        const formData = new FormData()
        const [type] = file.split('.').reverse()
        const headers = formData.getHeaders()
        const fileData = fs.createReadStream(file)
        if(file.startsWith('http')){
            const data=await this.request.get(file, {
                responseType: 'stream'
            })
            fileData.pipe(data.data)
        }
        formData.append('media', fileData)
        formData.append('type', type)
        return new Promise<Bot.MediaInfo>((resolve, reject) => {
            formData.getLength(async (e, l) => {
                if (e) return reject(e)
                headers['content-length'] = l
                const response = await this.request.post(
                    'https://oapi.dingtalk.com/media/upload',
                    formData,
                    {
                        headers: {
                            "Content-Type": 'multipart/form-data'
                        }
                    })
                resolve({
                    ...response.data,
                    type
                })
            })
        })
    }
    async sendDirectMessage(guild_id:string,message:Sendable,source?:Quotable){
        const sender=new Sender(this,`/dms/${guild_id}`,message,source)
        const result= await sender.sendMsg()
        this.logger.info(`send to Direct(${guild_id}): ${sender.brief}`)
        return result
    }
    async sendGuildMessage(channel_id: string, message: Sendable, source?: Quotable) {
        const sender=new Sender(this,`/channels/${channel_id}`,message,source)
        const result= await sender.sendMsg()
        this.logger.info(`send to Channel(${channel_id}): ${sender.brief}`)
        return result
    }
    async start() {
        await this.sessionManager.start()
        this.server.listen(this.options.port||=3723, () => {
            this.logger.info('server started as port: '+this.options.port)
        })
    }

    stop() {
        // this.sessionManager.stop()
    }
}

export namespace Bot {
    export interface Options {
        log_level?:LogLevel
        port?:number
        token:string
        access_token?:string
        intents:number|Intends[]
        ignore_self?:boolean
        proxy?:{
            host:string
            port:number
        }
        reconnect_interval?: number
        max_reconnect_count?: number
        heartbeat_interval?: number
        request_timeout?: number
        sandbox?: boolean
    }
    export interface Token {
        access_token: string
        expires_in: number
        cache: string
    }
    export type MediaInfo={
        id:string
        type:string
    }
}
