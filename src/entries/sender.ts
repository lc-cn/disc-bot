import {Dict, Bot, Quotable, Sendable} from "@";
import { randomInt } from "crypto";

export class Sender {
    brief: string = ''
    private isFile=false
    private messagePayload:Dict={
        msg_seq:randomInt(1,1000000),
        content:''
    }
    private buttons:Dict[]=[]
    private filePayload:Dict={
        srv_send_msg:true
    }
    constructor(private bot: Bot, private baseUrl: string,  private message: Sendable, private source: Quotable = {}) {
        this.messagePayload.msg_id=source.id
    }

    private getType(type: string):1|2|3 {
        return ['image', 'video', 'audio'].indexOf(type) + 1 as any
    }
    private parseFromTemplate(template:string){
        const result=[]
        const reg = /(<[^>]+>)/
        while (template.length) {
            const [match] = template.match(reg) || [];
            if (!match) break;
            const index = template.indexOf(match);
            const prevText = template.slice(0, index);
            if(prevText) result.push({
                type:'text',
                text:prevText
            })
            template = template.slice(index + match.length);
            const [type, ...attrArr] = match.slice(1, -1).split(',')
            const attrs = Object.fromEntries(attrArr.map((attr: string) => {
                const [key, value] = attr.split('=')
                try{
                    return [key,JSON.parse(value)]
                }catch{
                    return [key, value]
                }
            }))
            result.push({
                type,
                ...attrs
            })
        }
        if(template.length){
            result.push({
                type:'text',
                text:template
            })
        }
        return result
    }
    async processMessage(){
        if (!Array.isArray(this.message)) this.message = [this.message as any]
        while (this.message.length){
            const elem=this.message.shift()
            if (typeof elem === 'string') {
                const index=this.message.findIndex((item)=>item===elem)
                this.message.splice(index,0,...this.parseFromTemplate(elem))
                continue
            }
            const {type,...data}=elem
            switch (elem.type) {
                case 'reply':
                    this.messagePayload.msg_id = elem.id
                    this.filePayload.msg_id = elem.id
                    this.brief += `<$reply,msg_id=${elem.id}>`
                    break;
                case "at":
                    this.messagePayload.content += `<@${elem.user_id==='all'?'everyone':elem.user_id}>`
                    this.brief += `<$at,user=${elem.user_id==='all'?'everyone':elem.user_id}>`
                    break;
                case 'link':
                    this.messagePayload.content += `<#${elem.channel_id}>`
                    this.brief += `<$link,channel=${elem.channel_id}>`
                    break;
                case 'text':
                    this.messagePayload.content += elem.text
                    this.brief += elem.text
                    break;
                case 'face':
                    this.messagePayload.content += `<emoji:${elem.id}>`
                    this.brief += `<$face,id=${elem.id}>`
                    break;
                case 'image':
                case 'audio':
                case 'video':
                    if(this.messagePayload.msg_id){
                        this.messagePayload.content=this.messagePayload.content||' '
                        if(!this.baseUrl.startsWith('/v2')){
                            this.messagePayload.image=!elem.file?.startsWith('http')?`http://${elem.file}`:elem.file
                        }else{
                            this.messagePayload.msg_type=7
                            const result= await this.sendFile(elem.file,this.getType(elem.type))
                            this.messagePayload.media = { file_info: result.file_info }
                        }
                    }else{
                        if(!this.baseUrl.startsWith('/v2')){
                            this.messagePayload.image=!elem.file?.startsWith('http')?`http://${elem.file}`:elem.file
                        }else{
                            this.filePayload.file_type = this.getType(elem.type)
                            this.filePayload.url = !elem.file?.startsWith('http')?`http://${elem.file}`:elem.file
                            this.isFile = true
                        }
                    }
                    this.brief += `<${elem.type},url=${elem.file}>`
                    break;
                case 'markdown':
                    this.messagePayload.markdown = data
                    this.messagePayload.msg_type = 2
                    this.brief += `<#markdown,content=${elem.content}>`
                    break;
                case 'keyboard':
                    this.messagePayload.msg_type = 2
                    this.messagePayload.keyboard = data
                    break;
                case 'button':
                    this.buttons.push(data)
                    this.brief += `<$button,data=${JSON.stringify(data)}>`
                    break;
                case "ark":
                case "embed":
                    if(this.baseUrl.startsWith('/v2')) break
                    this.messagePayload.msg_type=type==='ark'?3:4
                    this.messagePayload[type]=data
                    break;
            }
        }
        if (this.buttons.length) {
            const rows = [];
            let row=[];
            for (let i = 0; i < this.buttons.length; i++) {
                if(row.length>5){
                    rows.push(row)
                    row=[]
                }
                if(Array.isArray(this.buttons[i].buttons)){
                    rows.push(this.buttons[i].buttons)
                    continue;
                }
                row.push(this.buttons[i])
            }
            this.messagePayload.keyboard = {
                content: {
                    rows: rows.map(row => {
                        return {
                            buttons: row
                        }
                    })
                },
            }
        }
    }
    private async sendFile(url: string, file_type: 1 | 2 | 3) {
        if(!url.startsWith('http')) url=`http://${url}`
        const {data: result} = await this.bot.request.post(this.baseUrl + '/files', {
            file_type,
            url,
            srv_send_msg:false,
        })
        return result
    }

    async sendMsg() {
        await this.processMessage()
        if(this.isFile){
            const {data:result} = await this.bot.request.post(this.baseUrl+'/files',this.filePayload)
            return result
        }
        const {data:result} = await this.bot.request.post(this.baseUrl+'/messages',this.messagePayload)
        return result
    }
}
