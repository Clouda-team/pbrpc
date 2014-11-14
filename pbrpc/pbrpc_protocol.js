/**
 * @file
 *  PB_RPC For Nodejs;
 * @author wangsu01@baidu.com;
 */
var Protobuffer = require('node-protobuf');
var path = require('path');
var fs = require('fs');
var format = require('util').format;
var EventEmitter = require('events').EventEmitter;
var assert = require('assert');

var zlib = require('zlib');

var pbproto = null , pbDesc = "pbrpc.desc";
var RPC_SERVICES = {};          // 当前可以处理的rpc接口
var RPC_MSG_CACHE = {};    // 缓存生成的消息编解码方法

var seriesNum = 0;      // 请求序列号, 以自增方式保证进程内唯一
var MAGIC_STR = "HULU";
var MSG_MAX_LENGTH = 100 * 1024 * 1024;

// 载入协议描述, 这里是一个同步操作.
pbproto = new Protobuffer(fs.readFileSync(__dirname + path.sep + pbDesc));

/**
 * @typedef {Object} RpcConfig
 * @property {string} serviceName - 指定服务名调
 * @property {boolean} gzip - 是否启用gzip压缩, default : false;
 * @property {string} desc - 接口描述文件的位置, 要求已经从.proto文件转换成的.desc文件.
 * @property {string} pkgName - 描述文件中的包名称,由于js无法从.desc中获取, 所以需手动指定
 * @property {Array<MethodDef>} methods - 方法描述.
 */

/**
 * @typedef {Object} MethodDef  
 * @property {string} msgin 调用方法的传入消息名称,必须在描述文件中已经定义.
 * @property {string} msgout 调用方法的返回消息名称,必须在描述文件中已经定义.
 * @property {int} index  方法的索引序号, 由于js无法自动生成,所以必须手定指定.
 */

/**
 * Header数据格式,
 * 具体信息参见: http://wiki.babel.baidu.com/twiki/bin/view/Com/Main/Hulu_rpc_protocols#基于TCP的通信协议头
 * @typedef {Object} HeaderInfo
 * @property {string} magic_str  协议标识，"HULU" 
 * @property {number} message_size 消息体总长度，不包含Head size 
 * @property {number} meta_size  rpc meta pack长度
 */

/**
 * @memberof pbrpc_protocol
 * 请求包的meta数据格式,
 * 具体信息参见: http://wiki.babel.baidu.com/twiki/bin/view/Com/Main/Hulu_rpc_protocols#基于TCP的协议的metaPack
 * @typedef {Object} RequestMetaInfo
 * @property {string} service_name 服务名称
 * @property {number} method_index 
 * @property {number} [compress_type] 一般为2,即gzip或者没有该项
 * @property {number} [correlation_id] 
 * @property {number} [log_id]
 * @property {ChunkInfo} [chunk_info] #JS版本暂不支持chunk发送数据,所以请注意发送数据体积
 */

/**
 * @memberof pbrpc_protocol
 * 响应包的meta数据格式,
 * 具体信息参见: http://wiki.babel.baidu.com/twiki/bin/view/Com/Main/Hulu_rpc_protocols#基于TCP的协议的metaPack
 * @typedef {Object} ResponseMetaInfo
 * @property {number} error_code 
 * @property {string} error_text 
 * @property {number} [compress_type] 一般为2,即gzip或者没有该项
 * @property {number} [correlation_id] 
 * @property {ChunkInfo} [chunk_info] #JS版本暂不支持chunk发送数据,所以请注意发送数据体积
 */

/**
 * 由接收到的数据解析出的Request包,用于server端处理接收数据
 * @typedef {Object} ReceiveReqPack
 * @property {RequestMetaInfo} meta 调用方法的传入消息名称,必须在描述文件中已经定义.
 * @property {buffer} data 调用方法的返回消息名称,必须在描述文件中已经定义.
 * @property {buffer} restBuf 解析后剩余的buffer数据
 */

/**
 * 由接收到的数据解析出的Response包,用于client端处理接收接据
 * @typedef {Object} ReceiveResPack  
 * @property {ResponseMetaInfo} meta 调用方法的传入消息名称,必须在描述文件中已经定义.
 * @property {buffer} data 调用方法的返回消息名称,必须在描述文件中已经定义.
 * @property {buffer} restBuf 解析后剩余的buffer数据
 */

/**
 * 传出之前的原始Request包,用于client端处理传出接据
 * @typedef {Object} SendReqPack
 * @property {RequestMetaInfo} meta 调用方法的传入消息名称,必须在描述文件中已经定义.
 * @property {buffer} data 调用方法的返回消息名称,必须在描述文件中已经定义.
 */

/**
 * 传出之前的原始Response包,用于server端处理传出接据
 * @typedef {Object} SendResPack  
 * @property {ResponseMetaInfo} meta 调用方法的传入消息名称,必须在描述文件中已经定义.
 * @property {buffer} data 调用方法的返回消息名称,必须在描述文件中已经定义.
 */

/**
 * 为了有代码提示.写成一个map.
 * 包含pbrpc.desc中所有定义的message的全名.
 * @readonly
 * @enum {string}
 */
var pbfns = {
    FileDescriptorSet:'baidu.hulu.pbrpc.FileDescriptorSet',
    FileDescriptorProto:'baidu.hulu.pbrpc.FileDescriptorProto',
    DescriptorProto:'baidu.hulu.pbrpc.DescriptorProto',
    FieldDescriptorProto:'baidu.hulu.pbrpc.FieldDescriptorProto',
    EnumDescriptorProto:'baidu.hulu.pbrpc.EnumDescriptorProto',
    EnumValueDescriptorProto:'baidu.hulu.pbrpc.EnumValueDescriptorProto',
    ServiceDescriptorProto:'baidu.hulu.pbrpc.ServiceDescriptorProto',
    MethodDescriptorProto:'baidu.hulu.pbrpc.MethodDescriptorProto',
    FileOptions:'baidu.hulu.pbrpc.FileOptions',
    MessageOptions:'baidu.hulu.pbrpc.MessageOptions',
    FieldOptions:'baidu.hulu.pbrpc.FieldOptions',
    EnumOptions:'baidu.hulu.pbrpc.EnumOptions',
    EnumValueOptions:'baidu.hulu.pbrpc.EnumValueOptions',
    ServiceOptions:'baidu.hulu.pbrpc.ServiceOptions',
    MethodOptions:'baidu.hulu.pbrpc.MethodOptions',
    UninterpretedOption:'baidu.hulu.pbrpc.UninterpretedOption',
    SourceCodeInfo:'baidu.hulu.pbrpc.SourceCodeInfo',
    ChunkInfo:'baidu.hulu.pbrpc.ChunkInfo',
    RpcRequestMeta:'baidu.hulu.pbrpc.RpcRequestMeta',
    RpcResponseMeta:'baidu.hulu.pbrpc.RpcResponseMeta'
};

/**
 * @memberof pbrpc_protocol
 * 基本错误码, 包含pbrp response中的error_code
 * see detail : 'http://wiki.babel.baidu.com/twiki/bin/view/Com/Main/Hulu_rpc_protocols#附录1 内部error_code'
 * @readonly
 * @enum {int}
 */
var ERR_CODE = {
    /* positive values are system error codes */
    SABER_OK : 0,
    SABER_ERROR_NOTIFY : -1,
    SABER_ERROR_INVALID_ARGS : -2,
    SABER_ERROR_INAVLID_LISTEN_ADDR : -3,
    SABER_ERROR_SYS_ERROR : -4,
    SABER_ERROR_NET_ERROR : -5,
    SABER_ERROR_CONNECT_ERROR : -6,
    SABER_ERROR_NOT_CREATED : -7,
    SABER_ERROR_NO_MEMORY : -8,
    SABER_ERROR_NO_WORKER : -9, // ThreadPool has Stopped or not started 
    SABER_ERROR_AFTER_BROKEN : -10,
    SABER_ERROR_ALREADY_FREED : -11,
    SABER_ERROR_ALREADY_EXECED : -12,
    SABER_ERROR_CONNECT_TIMEDOUT : -13,
    SABER_ERROR_BUF_WRITE_STREAM_IS_EMPTY : -14,
    SABER_ERROR_BUF_WRITE_STREAM_NO_AVAILABLE : -15,
    SABER_ERROR_CONN_CLOSED : -16,
    SABER_ERROR_END : -50
};

/**
 * 一起载入多个desc文件
 * @inner
 * @param fpath {Array|string} 载入的文件路径
 * @param event {EventEmitter} 复用的事件对像. 成功触发ok事件,失败触发error事件.
 * @returns {EventEmitter} 
 *      直接返回event参数,如果未提供则返回由方法内部创建的一个新的EventEmitter对像.
 */
var requireDesc = function(fpath,event){
    
    event = event || new EventEmitter();
    
    if(!fpath){
        setImmediate(function(){
            event.emit("error",new Error("fpath is required!"));
        });
        return event;
    }
    
    if(Array.isArray(fpath)){
        fpath.forEach(function(f){
            requireDesc(f, event);
        });
    }else{
        fs.readFile(fpath,function(err, data){
            if(err){
                event.emit("error", err, fpath);
                return;
            }
            event.emit("ok", data, fpath);
        });
    }
    return event;
};

/**
 * pbrpc_protocol 根名称空间.
 * 
 * @global
 * @exports pbrpc_protocol
 * @namespace {Function} pbrpc_protocol
 */
var pbrpc = module.exports = /** @lends {pbrpc_protocol} */{
    /**
     * 解析header.
     * @memberof pbrpc_protocol
     * @param buf {Buffer} 待解析的buffer对像.
     * @returns {HeaderInfo} 头信息.
     */
    parseHeader: function(buf){
        // 长度小于12直接认为格式错误
        assert(buf.length > 12, "buffer.length must greater 12");
        var rs = {};
        rs.magicStr = buf.toString("ascii",0,4);
        // 判断解析是否能继续;
        assert.equal(rs.magicStr, MAGIC_STR, 'magic_str is not "HULU"');
        // 继续解析两个长度;
        rs.messageSize =  buf.readInt32LE(4);
        rs.metaSize =  buf.readInt32LE(8);
        return rs;
    },
    /**
     * 生成header
     * @memberof pbrpc_protocol
     * @param messageSize {number}
     * @param metaSize {number}
     * @param buf {buffer}
     * @returns {buffer}
     */
    maekHeader: function(metaSize,paramSize,buf){
        buf = buf || new Buffer(12);
        buf.write(MAGIC_STR, 0, "ascii");      //magic_str
        buf.writeInt32LE(paramSize + metaSize, 4);
        buf.writeInt32LE(metaSize, 8);
        return buf;
    },
    /**
     * buffer中解析Response Meta信息.
     * @memberof pbrpc_protocol
     * @param buf {buffer} 待解析的buffer数据
     * @param header {HeaderInfo} 
     * @returns {ResponseMetaInfo}
     */
    praseResMetaPack: function(buf,header){
        if(!Buffer.isBuffer(buf) || buf.length === 0){
            throw new Error("arguments[0] not a buffer or empty");
        }
        if(!header || !header.metaSize || buf.length < (header.metaSize + 12)){
            throw new Error("Wrong header.metaSize or buffer.length");
        }
        var metaBuf = buf.slice(12, 12 + header.metaSize);
        var rs = pbproto.parse(metaBuf,pbfns.RpcResponseMeta);
        return rs;
    },
    /**
     * buffer中解析RequestMeta信息.
     * @memberof pbrpc_protocol
     * @param buf {buffer} 待解析的buffer数据
     * @param header {HeaderInfo} 
     * @returns {RequestMetaInfo}
     */
    praseReqMetaPack: function(buf,header){
        if(!Buffer.isBuffer(buf) || buf.length === 0){
            throw new Error("arguments[0] not a buffer or empty");
        }
        if(!header || !header.metaSize || buf.length < (header.metaSize + 12)){
            throw new Error("Wrong header.metaSize or buffer.length");
        }
        var metaBuf = buf.slice(12, 12 + header.metaSize);
        var rs = pbproto.parse(metaBuf,pbfns.RpcRequestMeta);
        return rs;
    },
    /**
     * 创建RequestMetaPack
     * @memberof pbrpc_protocol
     * @param metaData {RequestMetaInfo}
     * @returns {buffer}
     */
    makeReqMetaPack: function(metaData){
        return pbproto.serialize(metaData,pbfns.RpcRequestMeta);
    },
    /**
     * 创建ResponseMetaPack
     * @memberof pbrpc_protocol
     * @param metaData {ReponseMetaInfo}
     * @returns {buffer}
     */
    makeResMetaPack: function(metaData){
        return pbproto.serialize(metaData,pbfns.RpcResponseMeta);
    },
    /**
     * 根据给定原始信息,创建一个请求包.
     * @memberof pbrpc_protocol
     * @param reqBuf {buffer} 处理后的MethodPack.
     * @param serviceName
     * @param methodIndex
     * @param logId
     * @return {SendReqPack}
     */
    makeReqPack:function(sname,mname,params,logId,cb){
        
        cb = cb || logId;
        
        assert(cb instanceof Function,"callback is required!");
        
        var conf = RPC_SERVICES[sname];
        
        if(!conf){
            cb(new Error("no config for service[" + sname +"]"));
            return;
        }
        
        var methodConf = conf.methods && conf.methods[mname];
        
        if(!methodConf){
            cb(new Error("no config method [" + mname + "] on the service[" + sname +"]"));
            return;
        }
        
        var methodIndex = methodConf.index;
        var methodIn = methodConf.msgin;
        
        var pkname = conf.pkgName || "";
        var protocol = conf._p;
        
        var metaData = {
            service_name:sname,
            method_index:methodIndex,
            method_name:mname
        };
        
        if('number' === typeof logId){
            metaData.log_id = logId;
        }
        
        // 设置进程内唯一序列号
        var correlationId = metaData.correlation_id = seriesNum++;
        
        var paramBuf = protocol.serialize(params,pkname + '.' + methodIn);
        var pack;
        
        if(conf.gzip){
            // 类型2为gzip,这是目前唯一支持的压维方式;
            metaData.compress_type = 2; 
            zlib.gzip(paramBuf, function(err,rs){
                
                if(err){
                    cb(err);
                    return;
                }
                
                try{
                    pack = pbrpc.assemblyReqPack(metaData,rs);
                    cb(err,{
                        meta:metaData,
                        pack:pack
                    });
                }catch(err){
                    // 这里唯一的错误应该是由assemblyReqPack抛出的完整包的长度超出限制. 
                    // 即10 * 1024  * 1024
                    cb(err);
                }
            });
        }else{
            try{
                pack = pbrpc.assemblyReqPack(metaData,paramBuf);
                
                cb(null,{
                    meta:metaData,
                    pack:pack
                });
                
            }catch(err){
                // 这里唯一的错误应该是由assemblyReqPack抛出的完整包的长度超出限制. 
                // 即10 * 1024  * 1024
                cb(err);
            }
        }
    },
    /**
     * 创建并返回一个完整的请求包,这个方法的速度要快于makeReqPack,可以用于在连接层直接持有pbproto对像的情况下快速生成请求包.
     * 方法将序列化metaDate,并根据序列化后的metaPack与reqParamPack创建header
     * 
     * @inner
     * @memberof pbrpc_protocol
     * @param metaData {ReqMetaData}
     *      一个完整的MetaData, 
     *      具体信息参见: http://wiki.babel.baidu.com/twiki/bin/view/Com/Main/Hulu_rpc_protocols#基于TCP的协议的metaPack
     * @param reqBuf {buffer}   
     *      由于请求参数可能被gzip处理,所以这里要求直接是一个处理后的buffer,方法内将不再做任何处理,
     * @returns {buffer}
     *      一个完整的reqPack的buffer表示,可以直接由网络发送.
     */
    assemblyReqPack: function(metaData, reqBuf){
        
        var reqMetaBuf = pbrpc.makeReqMetaPack(metaData);
        
        // 大于最大长度. 需要使用chunk方式或进行gzip压缩已减少长度,暂时未实现,直接抛出异常.
        if(reqMetaBuf.length + reqBuf.length > MSG_MAX_LENGTH){
            //TODO chunk或gzip, 由于没办法测试,所以暂时未实现.
            throw new Error('packSize beyond the maximum limit');
        }
        
        var headerBuf = pbrpc.maekHeader(reqMetaBuf.length, reqBuf.length);
        
        return Buffer.concat([headerBuf,reqMetaBuf,reqBuf]);
    },
    /**
     * 对一个request包做header与meta解析. 
     * @memberof pbrpc_protocol
     * @param buf {buffer} 将解析的数据buffer对像
     * @returns {ReceiveReqPack} 解析后的包对像,包含meta{ReqMetaData}与pack两项内容.
     */
    parseReqPack: function(buf){
        var header = pbrpc.parseHeader(buf);
        var meta = pbrpc.praseReqMetaPack(buf,header);
        return {
            meta:meta,
            data:buf.slice(12 + header.metaSize, 12 + header.messageSize),
            restBuf:buf.slice(12 + header.messageSize)
        };
    },
    /**
     * 对一个response包做header与meta解析
     * @param buf {buffer} 将解析的数据buffer对像
     * @returns {ReceiveResPack}
     */
    parseResPack: function(buf){
        var header = pbrpc.parseHeader(buf);
        var meta = pbrpc.praseResMetaPack(buf,header);
        return {
            meta:meta,
            data:buf.slice(12 + header.metaSize, 12 + header.messageSize),
            restBuf:buf.slice(12 + header.messageSize)
        };
    },
    /**
     * 解析一个response中的数据部份.
     * @param pack {ReceiveResPack}
     *   需要解析的包
     * @param sname
     *   服务名称
     * @param mindex
     *   方法索引值
     * @param cb {function} 回调
     */
    parseResData:function(pack,sname,mindex,cb){
        if(!cb instanceof Function){
            throw new Error("callback is required!");
        }
        
        if(!pack.meta || !pack.data){
            throw new Error("invalid pack!");
        }
        var compressType = pack.meta.compress_type;
        if(compressType === undefined || compressType === 0 || compressType === 2){
            
            var parseData = function(err,rs){
                if(err){
                    cb(err);
                    return;
                }
                
                try{
                    var parseHandle = pbrpc.getResMsgParseHandleByIndex(sname,mindex);
                    cb(err,parseHandle(rs));
                }catch(e){
                    cb(e,null);
                }
            };
            
            // 解压缩
            if(compressType === 2){
                // gzip压缩
                zlib.unzip(pack.data,parseData);
            }else{
                //不压缩
                setImmediate(parseData,null,pack.data);
            }
            
            //查找解析消息类型.
            
        }else{
            cb(new Error("compress_type invalid or not support!"));
            return;
        }
        
    },
    _fullName:function(sname, mname, type){
        return sname + "#" + mname+"#" + type.toUpperCase();
    },
    _cacheMsgHandle:function(sname, mname, type, handle){
        return RPC_MSG_CACHE[pbrpc._fullName(sname, mname, type)] = handle;
    },
    /**
     * 创建一个闭包方法,用于快速解析指定的消息类型
     * 
     * @inner
     * @param pb
     * @param msgName
     * @returns {Function}
     */
    _createParseHandle: function(pb,msgName){
        return function(buf){
            return pb.parse(buf,msgName);
        };
    },
    _createMsgParseHandle:function(sname,mindex,type){
        var conf, mname, methodConf, msgName;
        
        if(!(conf = RPC_SERVICES[sname])){
            throw new Error("no config for service[" + sname +"]");
        }
        
        // 无论如何,同时获取index与name两个值;
        if(typeof(mindex) === "number"){
            //反查字符串名称
            mname = conf.reverseIndexs[mindex];
        }else{
            //非数字,直接认为是字符串;
            mname = mindex;
        }
        
        if(conf.methods){
            methodConf = conf.methods[mname];
        }
        
        if(!methodConf){
            throw new Error("no config method [" + mname + "] on the service[" + sname +"]");
        }
        
        mindex = methodConf.index;
        
        switch(type.toUpperCase()){
            case "IN":
                type = 'msgin';
                break;
            case "OUT":
                type = 'msgout';
                break;
            default:
                throw new Error("invalid type");
        }
        msgName = conf.pkgName + "." + methodConf[type];
        handle = pbrpc._createParseHandle(conf._p, msgName);
        
        pbrpc._cacheMsgHandle(sname,mname,"in",handle);
        pbrpc._cacheMsgHandle(sname,mindex,"in",handle);
        
        return handle;
    },
    /**
     * @param sname
     * @param mindex
     * @returns {Function}
     */
    getReqMsgParseHandleByIndex:function(sname,mindex){
        
        var handle = RPC_MSG_CACHE[pbrpc._fullName(sname,mindex,"IN")];  // 查找缓存
        
        if(handle instanceof Function){
            return handle;
        }
        
        return pbrpc._createMsgParseHandle(sname,mindex,'IN');
    },
    /**
     * 
     * @param sname
     * @param mname
     * @returns {Function}
     */
    getReqMsgParseHandleByName:function(sname,mname){
        
        var handle = RPC_MSG_CACHE[pbrpc._fullName(sname,mname,"IN")];  // 查找缓存
        
        if(handle instanceof Function){
            return handle;
        }
        
        return pbrpc._createMsgParseHandle(sname,mname,'IN');
    },
    /**
     * 
     * @param sname
     * @param mindex
     * @returns {Function}
     */
    getResMsgParseHandleByIndex:function(sname,mindex){
        var handle = RPC_MSG_CACHE[pbrpc._fullName(sname,mindex,"out")];  // 查找缓存
        
        if(handle instanceof Function){
            return handle;
        }
        
        return pbrpc._createMsgParseHandle(sname,mindex,'out');
    },
    /**
     * 
     * @param sname
     * @param mname
     * @returns {Function}
     */
    getResMsgParseHandleByName:function(sname,mname){
        var handle = RPC_MSG_CACHE[pbrpc._fullName(sname,mname,"out")];  // 查找缓存
        
        if(handle instanceof Function){
            return handle;
        }
        
        return pbrpc._createMsgParseHandle(sname,mname,'out');
    },
    /**
     * 添加可支持的服务接口定义
     * @memberof pbrpc_protocol
     * @param confs {Array|RpcConfig} 一个或一组配置信息
     * @param cb {Function} 添加完成后执行回调
     */
    addServices: function(confs,cb){
        
        var loadfiles = {}, // 待载入的desc文件与service的对照map, 这里使用map是为了对载入的文件去重.
            fns,            // 实际载入的文件path数组, 在触发载入前由Object.keys(loadfiles)获得
            waiting;        // 等待载入的文件数量, 载入时被置为fns.length,每完成一个文件自减1.
        
        if(!confs){
            cb(new Error("pbrpc configures is empty!"));
            return;
        }
        
        if(!Array.isArray(confs)){
            confs = [confs];
        }
        
        confs.forEach(function(conf){
            var sname = conf.serviceName, descfn = conf.desc;
            RPC_SERVICES[sname] = conf;
            
            if(loadfiles[descfn]){
                /*
                 * 发现重复使用一个定义的多个service, 
                 * 一般情况这应该是一种错误,但是由于JS版本的protobuffer实现
                 * 并不验证services定义,所以message部份是有被复用的可能的. 
                 * 因此在这里只打印一个警告消息.
                 */
                console.warn("repeat to load [%s] for serivces [%s,%s]",descfn , loadfiles[descfn], sname);
                
                if(!Array.isArray(loadfiles[descfn])){
                    loadfiles[descfn] = [loadfiles[descfn]];
                }
                
                loadfiles[descfn].push(conf.serviceName);
            }else{
                loadfiles[descfn] = conf.serviceName;
            }
        });
        
        var errs = [];
        
        var checkWaiting = function(){
            if(--waiting === 0){
                cb && cb(errs.length === 0 ? null :errs);
            }
        };
        
        var newRpcWrap = function(data,fpath){
            
            var sname = loadfiles[fpath];
            
            var createfactory = function(data,sname){
                var conf;
                
                if(data !== undefined){
                    conf = RPC_SERVICES[sname];
                    conf._p = new Protobuffer(data);
                    
                    if(conf.methods){
                        // 这里记录一个返向索引, 用于从方法的索引号找到方法名.
                        conf.reverseIndexs = [];
                        var method ;
                        for(var name in conf.methods){
                            method = conf.methods[name];
                            if(method.index !== undefined){
                                conf.reverseIndexs[method.index] = name;
                            }
                        }
                    }
                    
                }
                
                RPC_SERVICES[sname] = conf;
            };
//            debugger;
            // 如果一个描述文件对应多个rpc服务.
            if(Array.isArray(sname)){
                for(var i=0,len=sname.length;i<len;i++){
                    createfactory(data,sname[i]);
                }
            }else{
                createfactory(data,sname);
            }
        };
        
        var ev = new EventEmitter();
       
        ev.on("error",function(err,fpath){
            console.error("load [%s] fail, \n%s", err.path, err.stack);
            // 生成错误堆栈
            errs.push(err);
            // 空数据,将干掉rpc定义.
            newRpcWrap(fpath);
            checkWaiting();
        });
        
        ev.on("ok",function(data,fpath){
            console.log("load [%s] ok! data.length is %d",fpath,data.length);
            newRpcWrap(data,fpath);
            checkWaiting();
        });
        
        fns = Object.keys(loadfiles);
        waiting = fns.length;
        requireDesc(fns,ev);
    },
    /**
     * 返回或查询已定义的service描述对像
     * @memberof pbrpc_protocol
     * @param [serviceName] {string} 可能的名称,如果指定名称,则尝试返回指定的服务描述对像,如果不存在则返回null
     * @returns {any}
     */
    getServices: function(serviceName){
        if(serviceName){
            return RPC_SERVICES[serviceName] || null;
        }else{
            return RPC_SERVICES;
        }
    },
    
};