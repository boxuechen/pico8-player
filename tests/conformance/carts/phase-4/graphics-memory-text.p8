pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-authored phase 4d graphics, memory and text probe
local out=0x5200
local cursor=out

function put(v)
 poke(cursor,v or 0xff)
 cursor+=1
end

function putb(v)
 put(v and 1 or 0)
end

function putraw(v)
 poke4(0x5500,v)
 put(peek(0x5500))
 put(peek(0x5501))
 put(peek(0x5502))
 put(peek(0x5503))
end

function putstr(value)
 put(#value)
 for i=1,#value do put(ord(value,i)) end
end

function putpixels(x,y,w,h)
 for py=y,y+h-1 do
  for px=x,x+w-1,2 do
   put(pget(px,py)|(pget(px+1,py)<<4))
  end
 end
end

function probe_text()
 putstr(tostr())
 putstr(tostr(nil))
 putstr(tostr(17,1))
 putstr(tostr(17,2))
 putstr(tostr(17,3))

 putraw(tonum("123.5"))
 putraw(tonum("ffff",1))
 putraw(tonum("ffff0000",3))
 putraw(tonum("65536",2))
 putraw(tonum("not-a-number",4))
 putb(tonum("not-a-number")==nil)
 putraw(tonum(true))

 local binary=chr(65,0,322)
 put(#binary)
 local a,b,c=ord(binary,1,3)
 put(a) put(b) put(c)
 putb(ord(binary,4)==nil)
 putb(ord({},1)==nil)

 local values=split("1,2,,4")
 put(#values)
 for i=1,#values do
  putstr(type(values[i]))
  if type(values[i])=="number" then putraw(values[i]) else putstr(values[i]) end
 end

 local chars=split("abc",1)
 put(#chars)
 for value in all(chars) do putstr(value) end

 local literal=split("a|2|","|",false)
 put(#literal)
 for value in all(literal) do putstr(value) end

 putstr(type(nil))
 putstr(type(false))
 putstr(type(1))
 putstr(type("x"))
 putstr(type({}))
 putstr(type(function() end))
 putstr(type(cocreate(function() end)))
end

function probe_memory()
 memset(0xfffe,0xaa,4)
 put(peek(0xfffe)) put(peek(0xffff)) put(peek(0)) put(peek(1))

 poke(0x5300,1,2,3,4,5,6)
 memcpy(0x5301,0x5300,5)
 for i=0,5 do put(peek(0x5300+i)) end
 memcpy(0x5310,0x5301,5)
 memcpy(0x5311,0x5310,5)
 for i=0,5 do put(peek(0x5310+i)) end

 poke(0x5f55,0xe0)
 cls(6)
 pset(0,0,11)
 put(peek(0xe000))
 put(peek(0x6000))
end

function probe_graphics()
 cls(0)
 camera() clip() pal() palt() fillp()

 rrectfill(4,4,12,8,2,3)
 putpixels(4,4,12,8)
 rrect(20,4,12,8,2,5)
 putpixels(20,4,12,8)

 camera(2,1)
 clip(34,3,10,8)
 pal(3,9)
 fillp(0xa5a5)
 rrectfill(36,4,12,8,2,0x43)
 putpixels(34,3,12,8)

 camera()
 clip(52,3,8,6)
 fillp(0xffff.8000)
 poke(0x5f34,3)
 rrectfill(54,4,4,4,1,0x1806.0000)
 putpixels(52,3,8,6)
 clip() pal() fillp() poke(0x5f34,0)

 for x=0,7 do sset(8+x,0,x+1) end
 mset(0,0,1)
 tline(16)
 tline(64,70,71,70,0,0,1,0)
 putpixels(64,70,8,1)
 tline(13)
 tline(64,72,71,72,0,0,0.125,0)
 putpixels(64,72,8,1)

 -- Radius zero follows the width/height rectangle profile; invalid dimensions are no-ops.
 rrect(82,70,6,4,0,12)
 rrectfill(90,70,0,4,2,14)
 putpixels(82,70,10,4)
end

function _init()
 probe_text()
 probe_memory()
 probe_graphics()
 poke2(0x51fe,cursor-out)
end

function _update60() end

function _draw()
 memcpy(0x6000,out,peek2(0x51fe))
end
