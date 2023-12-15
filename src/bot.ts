import {EventEmitter} from 'events'
import FormData from 'form-data'
import * as fs from 'fs'
import {HttpsProxyAgent} from 'https-proxy-agent'
import {WebSocket} from 'ws';
import axios, {AxiosInstance, CreateAxiosDefaults} from 'axios'
import {SessionManager} from '@/sessionManager';
import * as path from "path";
import * as os from "os";
import {Dict} from "@/types";
import {Intends} from "@/constans";
import {OriginEvent} from "@/event";
import {DirectMessageEvent, GuildMessageEvent, Message} from "@/message";
import {Quotable, Sendable} from "@/elements";
import {Sender} from "@/entries/sender";

export class Bot extends EventEmitter {
    self_id=""
    nickname=""
    status=0;
    request: AxiosInstance
    ws?: WebSocket
    sessionManager: SessionManager

    constructor(public options: Bot.Options) {
        super();
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
                    console.info(`recv from Guild(${result.guild_id})Channel(${result.channel_id}): ${result.raw_message}`)
                    break;
                case 'message.direct':
                    messageEvent = new DirectMessageEvent(this as unknown as Bot, result)
                    console.info(`recv from Direct(${result.guild_id}): ${result.raw_message}`)
                    break;
            }
            return messageEvent
        }
        return result
    }
    private async saveToTemp(file: string) {
        const response = await this.request.get(file, {
            responseType: 'blob'
        })
        const fileData = Buffer.from(response.data)
        const [fileInfo] = file.split('/').reverse()
        const saveTo = path.resolve(os.tmpdir(), fileInfo)
        fs.writeFileSync(saveTo, fileData)
        return saveTo
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
        if (file.split('http')) file = await this.saveToTemp(file)
        const formData = new FormData()
        const [type] = file.split('.').reverse()
        const headers = formData.getHeaders()
        const fileData = fs.createReadStream(file)
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
        console.info(`send to Direct(${guild_id}): ${sender.brief}`)
        return result
    }
    async sendGuildMessage(channel_id: string, message: Sendable, source?: Quotable) {
        const sender=new Sender(this,`/channels/${channel_id}`,message,source)
        const result= await sender.sendMsg()
        console.info(`send to Channel(${channel_id}): ${sender.brief}`)
        return result
    }
    start() {
        this.sessionManager.start()
    }

    stop() {
        // this.sessionManager.stop()
    }
}

export namespace Bot {
    export interface Options {
        token:string
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
