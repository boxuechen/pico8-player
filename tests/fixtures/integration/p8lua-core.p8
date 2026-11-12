pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-authored phase 4c p8 lua/core-library probe
local out=0x5200

function put(v)
 poke(out,v)
 out+=1
end

function putb(v)
 put(v and 1 or 0)
end

function _init()
 local values={1,2,3}
 put(add(values,9,2))
 for value in all(values) do put(value) end
 put(del(values,2))
 for value in all(values) do put(value) end
 put(deli(values,2))
 for value in all(values) do put(value) end
 local item={}
 local other={}
 local identities={item,other}
 putb(del(identities,item)==item and identities[1]==other)

 local counted={5,5,6}
 put(count(counted))
 put(count(counted,5))
 local holes={1,nil,3}
 put(count(holes))
 for value in all(holes) do put(value) end

 local deleting={1,10,2,11,3,12}
 for value in all(deleting) do
  if value<10 then del(deleting,value) end
 end
 for value in all(deleting) do put(value) end

 local visited=0
 local deleting2={1,10,2,11,3,12}
 foreach(deleting2,function(value)
  visited+=value
  if value<10 then del(deleting2,value) end
 end,"ignored")
 for value in all(deleting2) do put(value) end
 put(visited)

 srand(33)
 poke4(out,rnd()) out+=4
 poke4(out,rnd(10)) out+=4
 put(rnd({7,8,9}))
 local state_a=peek4(0x5f44)
 local state_b=peek4(0x5f48)
 srand(33)
 rnd() rnd(10) rnd({7,8,9})
 putb(peek4(0x5f44)==state_a)
 putb(peek4(0x5f48)==state_b)
 poke4(0x5f44,0x1234) poke4(0x5f48,0x5678)
 local poked=rnd()
 poke4(0x5f44,0x1234) poke4(0x5f48,0x5678)
 putb(rnd()==poked)

 local word=sub("the quick",5,9)
 for i=1,#word do put(ord(word,i)) end
 local tail=sub("the quick",-2)
 for i=1,#tail do put(ord(tail,i)) end
 put(ord(sub("abc",2,true)))

 local co=cocreate(function(value)
  local resumed=yield(value+1,value+2)
  return resumed+3
 end)
 putb(cocreate==coroutine.create and coresume==coroutine.resume)
 putb(costatus==coroutine.status and yield==coroutine.yield)
 putb(costatus(co)=="suspended")
 local ok,a,b=coresume(co,10)
 putb(ok) put(a) put(b)
 putb(costatus(co)=="suspended")
 local ok2,c=coresume(co,20)
 putb(ok2) put(c)
 putb(costatus(co)=="dead")
 putb(coresume(co)==false)

 putb(pcall(add,1,2)==false)
 putb(pcall(count,1)==false)
 putb(pcall(sub,"abc",{})==false)
 local empty=0
 for value in all(nil) do empty+=1 end
 put(empty)
end

function _update60() end

function _draw()
 memcpy(0x6000,0x5200,64)
end
