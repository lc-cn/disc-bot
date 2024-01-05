import {MessageElem, Sendable} from "@/elements";
import {Bot} from "@/bot";
import {Dict} from "@/types";
import {trimQuote} from "@/utils";
import {User} from "@/entries/user";

export class Message {
    message_type: Message.SubType

    get self_id() {
        return this.bot.self_id
    }

    guild_id?: string
    channel_id?: string
    group_id?: string
    id: string
    message_id:string
    sender: Message.Sender
    user_id: string

    constructor(public bot: Bot, attrs: Partial<Message>) {
        Object.assign(this, attrs)
    }

    raw_message: string
    message_reference?: { message_id: string }
    message: Sendable


    get [Symbol.unscopables]() {
        return {
            bot: true
        }
    }


    toJSON() {
        return Object.fromEntries(Object.keys(this)
            .filter(key => {
                return typeof this[key] !== "function" && !(this[key] instanceof Bot)
            })
            .map(key => [key, this[key]])
        )
    }
}


export interface MessageEvent {
    reply(message: Sendable, quote?: boolean): Promise<any>
}

export class DirectMessageEvent extends Message implements MessageEvent {
    user_id: string
    channel_id: string

    constructor(bot: Bot, payload: Partial<Message>) {
        super(bot, payload);
        this.message_type = 'direct'
    }

    reply(message: Sendable) {
        return this.bot.sendDirectMessage(this.guild_id, message, this)
    }
}

export class GuildMessageEvent extends Message implements MessageEvent {
    guild_id: string
    guild_name: string
    channel_id: string
    channel_name: string

    constructor(bot: Bot, payload: Partial<Message>) {
        super(bot, payload);
        this.message_type = 'guild'
    }

    async reply(message: Sendable) {
        return this.bot.sendGuildMessage(this.channel_id, message, this)
    }
}

export namespace Message {
    export interface Sender {
        user_id: string
        user_name: string
        permissions: User.Permission[]
    }

    export type SubType = 'guild' | 'direct'

    export function parse(this: Bot, payload: Dict) {
        let template = payload.content || ''
        let result: MessageElem[] = []
        let brief: string = ''
        // 1. 处理文字表情混排
        const regex = /("[^"]*?"|'[^']*?'|`[^`]*?`|“[^”]*?”|‘[^’]*?’|<[^>]+?>)/;
        if(payload.message_reference){
            result.push({
                type:'reply',
                id:payload.message_reference.message_id
            })
            brief+=`<reply,id=${payload.message_reference.message_id}>`
        }
        while (template.length) {
            const [match] = template.match(regex) || [];
            if (!match) break;
            const index = template.indexOf(match);
            const prevText = template.slice(0, index);
            if (prevText) {
                result.push({
                    type: 'text',
                    text: prevText
                })
                brief += prevText
            }
            template = template.slice(index + match.length);
            if (match.startsWith('<')) {
                let [type, ...attrs] = match.slice(1, -1).split(',');
                if (type.startsWith('faceType')) {
                    type = 'face'
                    attrs = attrs.map((attr: string) => attr.replace('faceId', 'id'))
                } else if (type.startsWith('@')) {
                    if (type.startsWith('@!')) {
                        const id = type.slice(2)
                        type = 'at'
                        attrs = Object.entries(payload.mentions.find((u: Dict) => u.id === id) || {})
                            .map(([key, value]) => `${key==='id'?'user_id':key}=${value}`)
                    } else if (type === '@everyone') {
                        type = 'at'
                        attrs = ['user_id=all']
                    }
                } else if (/^[a-z]+:[0-9]+$/.test(type)) {
                    attrs = ['id=' + type.split(':')[1]]
                    type = 'face'
                }
                if([
                    'text',
                    'face',
                    'at',
                    'image',
                    'video',
                    'audio',
                    'markdown',
                    'button',
                    'link',
                    'reply',
                    'ark',
                    'embed'
                ].includes(type)){
                    result.push({
                        type,
                        ...Object.fromEntries(attrs.map((attr: string) => {
                            const [key, ...values] = attr.split('=')
                            return [key.toLowerCase(), trimQuote(values.join('='))]
                        }))
                    })
                    brief += `<${type},${attrs.join(',')}>`
                }else{
                    result.push({
                        type:'text',
                        text:match
                    })
                }
            }else{
                result.push({
                    type: "text",
                    text: match
                });
                brief += match;
            }
        }
        if (template) {
            result.push({
                type: 'text',
                text: template
            })
            brief += template
        }
        // 2. 将附件添加到消息中
        if (payload.attachments) {
            for (const attachment of payload.attachments) {
                let {content_type, ...data} = attachment
                const [type] = content_type.split('/')
                let url=data.src||data.url||''
                if(!url.startsWith('http')) url=`https://${url}`
                result.push({
                    type,
                    ...data,
                    file:url
                })
                brief += `<${type},${Object.entries(data).map(([key, value]) => `${key}=${value}`).join(',')}>`
            }
        }
        delete payload.attachments
        delete payload.mentions
        return [result, brief]
    }
}

