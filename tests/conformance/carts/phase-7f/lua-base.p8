pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-authored phase 7f pairs and lua base/raw probe
-- manual: tables, metatables and raw access
local out=0x5200

function put(v)
 poke(out,v)
 out+=1
end

function putb(v)
 put(v and 1 or 0)
end

function pack(...)
 return {n=select("#",...),...}
end

function _init()
 local count=0
 local values=0
 local numeric_keys=0
 local string_key=false
 for k,v in pairs({10,20,x=3}) do
  count+=1
  values+=v
  if type(k)=="number" then numeric_keys+=k end
  if k=="x" then string_key=true end
 end
 put(count) put(values) put(numeric_keys) putb(string_key)

 local empty=0
 for k,v in pairs({}) do empty+=1 end
 put(empty)
 local nil_count=0
 for k,v in pairs(nil) do nil_count+=1 end
 put(nil_count)

 local custom={}
 setmetatable(custom,{__pairs=function(self)
  local done=false
  return function()
   if not done then
    done=true
    return "z",9
   end
  end,self,nil
 end})
 local custom_count=0
 local custom_ok=false
 for k,v in pairs(custom) do
  custom_count+=1
  custom_ok=k=="z" and v==9
 end
 put(custom_count) putb(custom_ok)
 putb(pcall(pairs,1)==false)

 local t={}
 local mt={}
 putb(setmetatable(t,mt)==t)
 putb(getmetatable(t)==mt)
 putb(setmetatable(t,nil)==t and getmetatable(t)==nil)

 local locked={}
 setmetatable(locked,{__metatable="locked"})
 putb(getmetatable(locked)=="locked")
 putb(pcall(setmetatable,locked,{})==false)
 putb(pcall(setmetatable,1,{})==false)

 local indexed={}
 setmetatable(indexed,{__index=function() return 77 end})
 putb(indexed.missing==77 and rawget(indexed,"missing")==nil)

 local newindex_hits=0
 local assigned={}
 setmetatable(assigned,{__newindex=function() newindex_hits+=1 end})
 assigned.a=1
 local raw_result=rawset(assigned,"b",2)
 putb(newindex_hits==1 and raw_result==assigned and rawget(assigned,"b")==2)
 putb(pcall(rawget,1,"x")==false)
 putb(pcall(rawset,1,"x",1)==false)

 local eqmt={__eq=function() return true end}
 local a=setmetatable({},eqmt)
 local b=setmetatable({},eqmt)
 putb(a==b and not rawequal(a,b) and rawequal(a,a))

 local sized=setmetatable({4,5},{__len=function() return 99 end})
 putb(#sized==99 and rawlen(sized)==2)
 putb(rawlen(chr(97,0,98))==3)
 putb(pcall(rawlen,1)==false)

 put(select("#",10,nil,30))
 local selected=pack(select(2,10,nil,30))
 put(selected.n)
 putb(selected[1]==nil)
 put(selected[2])
 put(select(-1,10,20,30))
 put(pack(select(9,10,20,30)).n)
 putb(pcall(select,0,10,20)==false)
 putb(pcall(select,-4,10,20)==false)
end

function _update60() end

function _draw()
 memcpy(0x6000,0x5200,32)
end
